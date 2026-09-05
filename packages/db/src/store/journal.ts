import {
  type Account,
  type AccountKind,
  type DealPartiesAttestation,
  type FeeAccrualDeclaration,
  type FundsRef,
  type FxExecution,
  type Journal,
  type JournalEntry,
  type JournalEntryInput,
  type JournalEntryKind,
  type Posting,
  type ShortfallFunding,
  type TrancheSettlement,
  accountCode,
  appendEntry,
  clientKey,
  createJournalEntry,
  emptyJournal,
  feeCeiling,
  fxExecution,
  isClientRef,
  trancheSettlement,
} from '@sdelka/ledger';
import {
  type CurrencyCode,
  assertCurrencyCode,
  compareRational,
  fxRates,
  isoDate,
  money,
  rational,
} from '@sdelka/money';
import { accountKindRow } from '../accounts.ts';
import { DbError, DbErrorCode } from '../errors.ts';
import { type PoolClient, toBigInt } from '../pool.ts';
import { translating } from './errors.ts';
import type { WriteOutcome } from './port.ts';

/**
 * Журнал учёта в базе и обратно.
 *
 * **Обратная гидратация здесь есть, и прежняя редакция `test/int/support/write.ts`
 * утверждала, что её «нет и не будет».** Довод был такой: `TrancheSettlement`
 * держится на ambient-символе, любая реконструкция потребовала бы приведения
 * типа и уничтожила бы защиту, ради которой символ заведён. Довод верен ровно
 * наполовину.
 *
 * Что защищает символ: **изготовление нового** объявления расчёта. Утверждение
 * «эти лица — стороны этой сделки» обязано прийти из домена, потому что учёт
 * состава участников не знает. Что происходит при чтении: объявление, уже
 * лежащее в журнале — то есть уже прошедшее и домен, и конструктор записи, и
 * все ограничения схемы, — восстанавливается **в то же самое значение**. Это не
 * новое утверждение, а поднятие записанного.
 *
 * Приведение поэтому осталось одно и стоит ниже, в `attestationOfRow`, и
 * обставлено тремя условиями, каждое из которых проверяемо:
 *
 * 1. источник значения — строка `sdelka.ledger_entry`, а журнал только
 *    дополняется (триггеры `forbid_ledger_*_mutation`, гранты роли приложения
 *    без `UPDATE`/`DELETE`);
 * 2. восстановленное подтверждение немедленно проверяется `trancheSettlement()`
 *    против той же строки: сказать оно может ровно то, что в строке записано,
 *    и ни на букву больше;
 * 3. сама запись собирается `createJournalEntry`, который сверяет объявление с
 *    проводками (`assertClientOwnerMoveOnlySettles`). Расчёт, объявляющий
 *    посторонних, из строки не соберётся.
 *
 * Единственный путь злоупотребить — вписать поддельную строку прямо в
 * `ledger_entry` в обход порта. Но это и есть подделка журнала, а не её
 * следствие: порт наружу принимает только `JournalEntry`, собранный учётом.
 */

/* ------------------------------------------------------------------------- */
/* Все четыре объявления записи хранятся                                     */
/* ------------------------------------------------------------------------- */

/**
 * **Отказа `db.entry.declaration_not_storable` больше нет, и это не
 * послабление.** Он стоял, пока `sdelka.ledger_entry` держала одно объявление
 * из четырёх: у обмена пропали бы три курса и дата, у начисления — версия
 * тарифного плана, у довнесения — ссылка на признание, а у расчёта — потолок
 * удержания. Не писать того, чего не прочтёшь обратно, было единственным
 * честным ответом.
 *
 * `0021_entry_declarations.sql` завела колонки под все четыре, поэтому отвергать
 * стало нечего: непредставимого поля у записи не осталось ни одного. Что
 * держало правило раньше — «схема отстала от домена» — теперь держит карта
 * `entry-shape.ts`: новое поле объявления роняет `pnpm typecheck`, а не первую
 * вставку.
 */

/* ------------------------------------------------------------------------- */
/* TS → колонки                                                              */
/* ------------------------------------------------------------------------- */

interface AccountColumns {
  readonly accountKind: string;
  readonly accountCurrency: string | null;
  readonly clientKey: string | null;
  readonly accountDealId: string | null;
  readonly accountTrancheId: string | null;
  readonly conversionId: string | null;
}

export function accountColumns(account: Account): AccountColumns {
  return {
    accountKind: account.kind,
    accountCurrency: 'currency' in account ? account.currency : null,
    clientKey: 'clientKey' in account ? account.clientKey : null,
    accountDealId: 'dealId' in account ? account.dealId : null,
    accountTrancheId: 'trancheId' in account ? account.trancheId : null,
    conversionId: 'conversionId' in account ? account.conversionId : null,
  };
}

interface AttributionColumns {
  readonly clientKey: string | null;
  readonly dealId: string | null;
  readonly trancheId: string | null;
}

export function attributionColumns(ref: FundsRef | null): AttributionColumns {
  if (ref === null) return { clientKey: null, dealId: null, trancheId: null };
  return isClientRef(ref)
    ? { clientKey: ref.clientKey, dealId: null, trancheId: null }
    : { clientKey: null, dealId: ref.dealId, trancheId: ref.trancheId };
}

/* ------------------------------------------------------------------------- */
/* Запись → колонки                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Одна колонка `sdelka.ledger_entry` и то, чем она заполняется.
 *
 * Список **один** на запись и на чтение: `INSERT`, `SELECT` и порядок значений
 * собираются из него же. Два списка колонок рядом расходятся ровно тогда, когда
 * добавляется поле, — то есть в тот единственный момент, когда расхождение
 * дорого.
 */
interface EntryColumn {
  readonly name: string;
  readonly of: (entry: JournalEntry) => unknown;
}

/**
 * Число в базу уходит **строкой**, а не числом: `bigint` через `number` не
 * проходит нигде, включая параметр запроса (красная линия №4). Ровно то же
 * правило, что у суммы проводки, и оно распространяется на числитель и
 * знаменатель курса: курс — это то, из чего сумма считается.
 */
function minorText(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

const ENTRY_COLUMNS: readonly EntryColumn[] = Object.freeze([
  { name: 'entry_id', of: (entry) => entry.id },
  { name: 'occurred_at', of: (entry) => entry.occurredAt },
  { name: 'kind', of: (entry) => entry.kind },
  { name: 'memo_key', of: (entry) => entry.memoKey },
  { name: 'corrects_entry_id', of: (entry) => entry.correctsEntryId },

  { name: 'settles_deal_id', of: (entry) => entry.settles?.deal.dealId ?? null },
  { name: 'settles_tranche_id', of: (entry) => entry.settles?.deal.trancheId ?? null },
  { name: 'settles_payer', of: (entry) => entry.settles?.payer ?? null },
  { name: 'settles_recipient', of: (entry) => entry.settles?.recipient ?? null },
  { name: 'settles_evidence_ref', of: (entry) => entry.settles?.evidenceRef ?? null },
  {
    name: 'settles_ceiling_numerator',
    of: (entry) => minorText(entry.settles?.ceiling.maxShare.numerator ?? null),
  },
  {
    name: 'settles_ceiling_denominator',
    of: (entry) => minorText(entry.settles?.ceiling.maxShare.denominator ?? null),
  },

  { name: 'converts_conversion_id', of: (entry) => entry.converts?.conversionId ?? null },
  {
    name: 'converts_source_currency',
    of: (entry) => entry.converts?.converted.source.currency ?? null,
  },
  {
    name: 'converts_source_amount_minor',
    of: (entry) => minorText(entry.converts?.converted.source.minor ?? null),
  },
  {
    name: 'converts_target_currency',
    of: (entry) => entry.converts?.converted.target.currency ?? null,
  },
  {
    name: 'converts_target_amount_minor',
    of: (entry) => minorText(entry.converts?.converted.target.minor ?? null),
  },
  {
    name: 'converts_client_rate_numerator',
    of: (entry) => minorText(entry.converts?.converted.rates.client.value.numerator ?? null),
  },
  {
    name: 'converts_client_rate_denominator',
    of: (entry) => minorText(entry.converts?.converted.rates.client.value.denominator ?? null),
  },
  {
    name: 'converts_reference_rate_numerator',
    of: (entry) => minorText(entry.converts?.converted.rates.reference.value.numerator ?? null),
  },
  {
    name: 'converts_reference_rate_denominator',
    of: (entry) => minorText(entry.converts?.converted.rates.reference.value.denominator ?? null),
  },
  {
    name: 'converts_official_rate_numerator',
    of: (entry) => minorText(entry.converts?.converted.rates.official.value.numerator ?? null),
  },
  {
    name: 'converts_official_rate_denominator',
    of: (entry) => minorText(entry.converts?.converted.rates.official.value.denominator ?? null),
  },
  { name: 'converts_as_of', of: (entry) => entry.converts?.converted.asOf ?? null },

  { name: 'accrues_deal_id', of: (entry) => entry.accrues?.deal.dealId ?? null },
  { name: 'accrues_tranche_id', of: (entry) => entry.accrues?.deal.trancheId ?? null },
  { name: 'accrues_fee_currency', of: (entry) => entry.accrues?.fee.currency ?? null },
  {
    name: 'accrues_fee_amount_minor',
    of: (entry) => minorText(entry.accrues?.fee.minor ?? null),
  },
  { name: 'accrues_tariff_version_id', of: (entry) => entry.accrues?.tariffVersionId ?? null },

  { name: 'funds_recognised_entry_id', of: (entry) => entry.funds?.recognisedEntryId ?? null },
  { name: 'funds_owner', of: (entry) => entry.funds?.owner ?? null },
  { name: 'funds_amount_currency', of: (entry) => entry.funds?.amount.currency ?? null },
  { name: 'funds_amount_minor', of: (entry) => minorText(entry.funds?.amount.minor ?? null) },
]);

/** Имена колонок записи в порядке, в котором их ждут `INSERT` и `SELECT`. */
export const ENTRY_COLUMN_NAMES: readonly string[] = Object.freeze(
  ENTRY_COLUMNS.map((column) => column.name),
);

/** Значения записи в том же порядке. */
export function entryValues(entry: JournalEntry): readonly unknown[] {
  return ENTRY_COLUMNS.map((column) => column.of(entry));
}

/* ------------------------------------------------------------------------- */
/* Колонки → TS                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Строка `sdelka.ledger_entry` так, как её отдаёт драйвер.
 *
 * `numeric` остаётся строкой (`src/pool.ts`), поэтому суммы, числители и
 * знаменатели объявлены `string | null`, а не `number`: `number` здесь и есть
 * та самая тихая потеря точности, ради которой заведены разборщики типов.
 */
interface EntryRow {
  readonly entry_id: string;
  readonly occurred_at: Date;
  readonly kind: string;
  readonly memo_key: string;
  readonly corrects_entry_id: string | null;

  readonly settles_deal_id: string | null;
  readonly settles_tranche_id: string | null;
  readonly settles_payer: string | null;
  readonly settles_recipient: string | null;
  readonly settles_evidence_ref: string | null;
  readonly settles_ceiling_numerator: string | null;
  readonly settles_ceiling_denominator: string | null;

  readonly converts_conversion_id: string | null;
  readonly converts_source_currency: string | null;
  readonly converts_source_amount_minor: string | null;
  readonly converts_target_currency: string | null;
  readonly converts_target_amount_minor: string | null;
  readonly converts_client_rate_numerator: string | null;
  readonly converts_client_rate_denominator: string | null;
  readonly converts_reference_rate_numerator: string | null;
  readonly converts_reference_rate_denominator: string | null;
  readonly converts_official_rate_numerator: string | null;
  readonly converts_official_rate_denominator: string | null;
  readonly converts_as_of: string | null;

  readonly accrues_deal_id: string | null;
  readonly accrues_tranche_id: string | null;
  readonly accrues_fee_currency: string | null;
  readonly accrues_fee_amount_minor: string | null;
  readonly accrues_tariff_version_id: string | null;

  readonly funds_recognised_entry_id: string | null;
  readonly funds_owner: string | null;
  readonly funds_amount_currency: string | null;
  readonly funds_amount_minor: string | null;
}

interface PostingRow {
  readonly entry_id: string;
  readonly ord: number;
  readonly account_kind: string;
  readonly account_currency: string | null;
  readonly client_key: string | null;
  readonly account_deal_id: string | null;
  readonly account_tranche_id: string | null;
  readonly conversion_id: string | null;
  readonly direction: string;
  readonly currency: string;
  readonly amount_minor: string;
  readonly account_code: string;
  readonly attribution_client_key: string | null;
  readonly attribution_deal_id: string | null;
  readonly attribution_tranche_id: string | null;
}

/**
 * Счёт из колонок.
 *
 * Форма собирается **по справочнику видов счетов** (`accountKindRow`), а не
 * перечнем `switch` по имени вида: перечень имён счетов в этом проекте дважды
 * оказывался неполным, и неполнота была тихой. Здесь полноту держит тот же
 * `Record<AccountKind, Account>`, что и в `src/accounts.ts`, — новый вид счёта
 * ломает `pnpm typecheck`, а не первую вставку на проде.
 *
 * Правильность сборки доказывается сравнением с вычисляемой колонкой
 * `account_code`: её выражение написано в SQL, `accountCode()` — в TS, и
 * совпадение двух независимых ответов и есть проверка круга.
 */
function accountOfRow(row: PostingRow): Account {
  const kind = row.account_kind as AccountKind;
  const spec = accountKindRow(kind);
  const parts: Record<string, unknown> = { kind };
  if (spec.needsCurrency) parts['currency'] = assertCurrencyCode(row.account_currency ?? '');
  if (spec.needsClient) parts['clientKey'] = clientKey(row.client_key ?? '');
  if (spec.needsTranche) {
    parts['dealId'] = row.account_deal_id ?? '';
    parts['trancheId'] = row.account_tranche_id ?? '';
  }
  if (spec.needsConversion) parts['conversionId'] = row.conversion_id ?? '';
  const account = Object.freeze(parts) as Account;
  const rebuilt = accountCode(account);
  if (rebuilt !== row.account_code) {
    throw new DbError(DbErrorCode.postingAccountCodeMismatch, {
      entryId: row.entry_id,
      ord: String(row.ord),
      stored: row.account_code,
      rebuilt,
    });
  }
  return account;
}

function attributionOfRow(row: PostingRow): FundsRef | null {
  if (row.attribution_client_key !== null) {
    return Object.freeze({ clientKey: clientKey(row.attribution_client_key) });
  }
  if (row.attribution_deal_id !== null && row.attribution_tranche_id !== null) {
    return Object.freeze({ dealId: row.attribution_deal_id, trancheId: row.attribution_tranche_id });
  }
  return null;
}

function postingOfRow(row: PostingRow): Posting {
  return Object.freeze({
    account: accountOfRow(row),
    direction: row.direction === 'debit' ? ('debit' as const) : ('credit' as const),
    amount: money(assertCurrencyCode(row.currency) as CurrencyCode, toBigInt(row.amount_minor)),
    attribution: attributionOfRow(row),
  });
}

/**
 * Подтверждение сторон, поднятое из строки. Единственное приведение в пакете —
 * см. заголовок файла: значения этого типа не существует, построить его кодом
 * нельзя, и именно поэтому домен обязан выдавать его сам. Здесь оно не
 * выдаётся, а восстанавливается из уже записанного объявления, и следующей же
 * строкой сверяется с ним.
 */
function attestationOfRow(row: EntryRow): DealPartiesAttestation {
  return {
    dealId: row.settles_deal_id ?? '',
    trancheId: row.settles_tranche_id ?? '',
    payer: clientKey(row.settles_payer ?? ''),
    recipient: clientKey(row.settles_recipient ?? ''),
    evidenceRef: row.settles_evidence_ref ?? '',
  } as unknown as DealPartiesAttestation;
}

/**
 * Объявление расчёта вместе с потолком удержания.
 *
 * Потолок собирается `feeCeiling`, а не литералом: доля не бывает
 * отрицательной и не бывает больше единицы, и проверяет это учёт, а не мы.
 * Дробь при этом сокращается (`rational`), поэтому `5/10` из базы даёт ту же
 * величину, что `1/2`, — сравниваются величины, а не форма записи.
 *
 * **Сверка после сборки — не украшение.** `trancheSettlement` применяет к
 * объявленному потолку `strictestFeeCeiling` с жёстким пределом учёта, то есть
 * потолок, лежащий в базе шире жёсткого, вернулся бы **суженным**: чтение
 * отдало бы не то, что записано. Через порт такая строка не попадает — потолок
 * пишется тем же значением, которое собрал учёт, — но попасть в таблицу мимо
 * порта она может, и тогда расхождение обязано иметь имя, а не тишину. Тот же
 * приём, что у `account_code` в проводке.
 */
function settlesOfRow(row: EntryRow): TrancheSettlement | null {
  if (row.settles_deal_id === null) return null;
  const stored = rational(
    toBigInt(row.settles_ceiling_numerator),
    toBigInt(row.settles_ceiling_denominator),
  );
  const settlement = trancheSettlement(
    { dealId: row.settles_deal_id, trancheId: row.settles_tranche_id ?? '' },
    clientKey(row.settles_payer ?? ''),
    clientKey(row.settles_recipient ?? ''),
    attestationOfRow(row),
    feeCeiling(stored),
  );
  if (compareRational(settlement.ceiling.maxShare, stored) !== 0) {
    throw new DbError(DbErrorCode.entryCeilingMismatch, {
      entryId: row.entry_id,
      stored: `${stored.numerator}/${stored.denominator}`,
      rebuilt: `${settlement.ceiling.maxShare.numerator}/${settlement.ceiling.maxShare.denominator}`,
    });
  }
  return settlement;
}

/**
 * Объявление обмена: ключ, обе ноги, три курса и дата.
 *
 * Пара валют курса не хранится, а берётся из валют ног — см. `entry-shape.ts`.
 * Собирается через `fxExecution`, поэтому строка, в которой встречная сумма не
 * равна исходной по клиентскому курсу с усечением, поднимает
 * `entry.conversion_declaration_mismatch` **на чтении**: пересчёт делает та же
 * реализация, что и при записи, второй на PL/pgSQL нет и не будет.
 */
function convertsOfRow(row: EntryRow): FxExecution | null {
  const conversionId = row.converts_conversion_id;
  if (conversionId === null) return null;
  const base = assertCurrencyCode(row.converts_source_currency ?? '');
  const quote = assertCurrencyCode(row.converts_target_currency ?? '');
  const rates = fxRates(base, quote, {
    client: rational(
      toBigInt(row.converts_client_rate_numerator),
      toBigInt(row.converts_client_rate_denominator),
    ),
    reference: rational(
      toBigInt(row.converts_reference_rate_numerator),
      toBigInt(row.converts_reference_rate_denominator),
    ),
    official: rational(
      toBigInt(row.converts_official_rate_numerator),
      toBigInt(row.converts_official_rate_denominator),
    ),
  });
  return fxExecution(conversionId, {
    source: money(base, toBigInt(row.converts_source_amount_minor)),
    target: money(quote, toBigInt(row.converts_target_amount_minor)),
    rates,
    asOf: isoDate(row.converts_as_of ?? ''),
  });
}

/** Объявление начисления комиссии вместе с версией тарифного плана (§4.2). */
function accruesOfRow(row: EntryRow): FeeAccrualDeclaration | null {
  const dealId = row.accrues_deal_id;
  if (dealId === null) return null;
  return Object.freeze({
    deal: Object.freeze({ dealId, trancheId: row.accrues_tranche_id ?? '' }),
    fee: money(
      assertCurrencyCode(row.accrues_fee_currency ?? ''),
      toBigInt(row.accrues_fee_amount_minor),
    ),
    tariffVersionId: row.accrues_tariff_version_id ?? '',
  });
}

/** Объявление довнесения недостачи со ссылкой на признание. */
function fundsOfRow(row: EntryRow): ShortfallFunding | null {
  const recognisedEntryId = row.funds_recognised_entry_id;
  if (recognisedEntryId === null) return null;
  return Object.freeze({
    recognisedEntryId,
    owner: clientKey(row.funds_owner ?? ''),
    amount: money(
      assertCurrencyCode(row.funds_amount_currency ?? ''),
      toBigInt(row.funds_amount_minor),
    ),
  });
}

function entryOfRows(row: EntryRow, postings: readonly PostingRow[]): JournalEntry {
  const kind = row.kind as JournalEntryKind;
  const base = {
    id: row.entry_id,
    // `occurredAt` в записи — строка ISO-8601, и в базе это `timestamptz`.
    // Драйвер отдаёт `Date`; обратно приводим тем же способом, каким запись
    // строилась (`new Date(...).toISOString()`), иначе круг замкнётся на
    // строке, отличающейся часовым поясом.
    occurredAt: row.occurred_at.toISOString(),
    kind,
    memoKey: row.memo_key,
    postings: postings.map(postingOfRow),
  };
  // Необязательные поля добавляются **только когда они есть**: у
  // `JournalEntryInput` они объявлены `?`, и `undefined` на их месте — не то же
  // самое, что отсутствие ключа (`assertEntryWellFormed` различает это прямо).
  const settlement = settlesOfRow(row);
  const settles = settlement === null ? {} : { settles: settlement };
  const conversion = convertsOfRow(row);
  const converts = conversion === null ? {} : { converts: conversion };
  const accrual = accruesOfRow(row);
  const accrues = accrual === null ? {} : { accrues: accrual };
  const funding = fundsOfRow(row);
  const funds = funding === null ? {} : { funds: funding };
  const corrects =
    row.corrects_entry_id === null ? {} : { correctsEntryId: row.corrects_entry_id };
  const input: JournalEntryInput = {
    ...base,
    ...settles,
    ...converts,
    ...accrues,
    ...funds,
    ...corrects,
  };
  // Сборка идёт через **конструктор учёта**, а не литералом. Это и есть второй
  // контур инвариантов на чтении: строка, из которой не собирается запись,
  // поднимает `LedgerError` с тем же ключом, что и при записи, — баланс,
  // отнесение, форма объявления, ссылка исправления.
  return createJournalEntry(input);
}

/* ------------------------------------------------------------------------- */
/* Запись                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Список колонок и список подстановок собираются из одного источника
 * (`ENTRY_COLUMNS`), а не пишутся руками рядом. Тридцать три колонки и
 * тридцать три `$n` — это ровно тот размер, на котором список, набранный
 * вручную, однажды разъезжается на одну позицию, и разъезжается молча: типы
 * колонок совпадают, и база принимает.
 */
const ENTRY_COLUMN_LIST = ENTRY_COLUMN_NAMES.join(', ');
const ENTRY_PLACEHOLDERS = ENTRY_COLUMN_NAMES.map((_name, index) => `$${index + 1}`).join(', ');

const INSERT_ENTRY = `
  INSERT INTO sdelka.ledger_entry (${ENTRY_COLUMN_LIST})
  VALUES (${ENTRY_PLACEHOLDERS})
  ON CONFLICT (entry_id) DO NOTHING
  RETURNING entry_id`;

const INSERT_POSTING = `
  INSERT INTO sdelka.ledger_posting (
    entry_id, ord, account_kind, account_currency, client_key,
    account_deal_id, account_tranche_id, conversion_id,
    direction, currency, amount_minor,
    attribution_client_key, attribution_deal_id, attribution_tranche_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;

const SELECT_ENTRY = `
  SELECT ${ENTRY_COLUMN_LIST}
    FROM sdelka.ledger_entry
   WHERE entry_id = $1`;

const SELECT_POSTINGS = `
  SELECT entry_id, ord, account_kind, account_currency, client_key,
         account_deal_id, account_tranche_id, conversion_id,
         direction, currency, amount_minor, account_code,
         attribution_client_key, attribution_deal_id, attribution_tranche_id
    FROM sdelka.ledger_posting
   WHERE entry_id = ANY($1::text[])
   ORDER BY entry_id, ord`;

async function readEntry(client: PoolClient, entryId: string): Promise<JournalEntry | null> {
  const head = await client.query<EntryRow>(SELECT_ENTRY, [entryId]);
  const row = head.rows[0];
  if (row === undefined) return null;
  const postings = await client.query<PostingRow>(SELECT_POSTINGS, [[entryId]]);
  return entryOfRows(row, postings.rows);
}

/**
 * Совпадает ли лежащая запись с той, которую пишем.
 *
 * Сравниваются **доменные значения**, а не строки таблицы: сравнение колонок
 * проверяло бы равенство собственной проекции, и поле, которое проекция теряет,
 * всегда равнялось бы само себе. Записи журнала — замороженные значения без
 * циклов и без плавающей точки, поэтому канонический `JSON.stringify` с
 * `bigint` в строку здесь честен.
 */
function sameEntry(left: JournalEntry, right: JournalEntry): boolean {
  const shape = (entry: JournalEntry): string =>
    JSON.stringify(entry, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    );
  return shape(left) === shape(right);
}

async function appendOne(client: PoolClient, entry: JournalEntry): Promise<boolean> {
  const inserted = await client.query<{ entry_id: string }>(INSERT_ENTRY, [
    ...entryValues(entry),
  ]);
  if (inserted.rowCount === 0) {
    // Строка под этим идентификатором уже лежит. Повтор — это когда лежит **то
    // же самое**; иначе конфликт с именем. `ON CONFLICT DO NOTHING` в одиночку
    // здесь недопустим: он одинаково молчит и о повторе, и о подмене.
    const existing = await readEntry(client, entry.id);
    if (existing !== null && sameEntry(existing, entry)) return false;
    throw new DbError(DbErrorCode.stepConflict, { relation: 'ledger_entry', id: entry.id });
  }
  let ord = 0;
  for (const posting of entry.postings) {
    const account = accountColumns(posting.account);
    const attribution = attributionColumns(posting.attribution);
    await client.query(INSERT_POSTING, [
      entry.id,
      ord,
      account.accountKind,
      account.accountCurrency,
      account.clientKey,
      account.accountDealId,
      account.accountTrancheId,
      account.conversionId,
      posting.direction,
      posting.amount.currency,
      // Сумма уходит в базу **строкой**, а не числом: `bigint` через число не
      // проходит нигде, включая параметр запроса (красная линия №4).
      posting.amount.minor.toString(),
      attribution.clientKey,
      attribution.dealId,
      attribution.trancheId,
    ]);
    ord += 1;
  }
  return true;
}

export async function appendJournal(
  client: PoolClient,
  entries: readonly JournalEntry[],
): Promise<WriteOutcome> {
  return translating(async () => {
    let written = 0;
    let repeated = 0;
    for (const entry of entries) {
      if (await appendOne(client, entry)) written += 1;
      else repeated += 1;
    }
    return Object.freeze({ written, repeated });
  });
}

/* ------------------------------------------------------------------------- */
/* Чтение                                                                    */
/* ------------------------------------------------------------------------- */

const SELECT_ALL_ENTRIES = `
  SELECT ${ENTRY_COLUMN_LIST}
    FROM sdelka.ledger_entry
   ORDER BY seq`;

/**
 * Журнал целиком.
 *
 * Порядок — по `seq`, то есть по порядку, в котором факты стали известны, а не
 * по `occurred_at`: возраст открытой позиции по обмену и возраст транзита
 * считаются именно так (`0002_ledger.sql`), и две записи с одной меткой времени
 * сделали бы порядок случайным.
 *
 * Сборка идёт `appendEntry`, а не `Object.freeze({ entries })`. Разница
 * существенная: `appendEntry` заново прогоняет правила, которым нужна история, —
 * зеркальность исправления, «расчёт отматывается один раз», идемпотентность
 * начисления, ключ конверсии, разрешение недостачи. То есть прочитанный журнал
 * не просто похож на записанный: он **снова проходит** все проверки учёта, и
 * журнал, который база приняла бы, а код нет, обнаруживается на чтении, а не в
 * отчётности через месяц.
 */
export async function readJournal(client: PoolClient): Promise<Journal> {
  return translating(async () => {
    const head = await client.query<EntryRow>(SELECT_ALL_ENTRIES);
    if (head.rows.length === 0) return emptyJournal;
    const ids = head.rows.map((row) => row.entry_id);
    const postings = await client.query<PostingRow>(SELECT_POSTINGS, [ids]);
    const byEntry = new Map<string, PostingRow[]>();
    for (const row of postings.rows) {
      const bucket = byEntry.get(row.entry_id);
      if (bucket === undefined) byEntry.set(row.entry_id, [row]);
      else bucket.push(row);
    }
    let journal = emptyJournal;
    for (const row of head.rows) {
      journal = appendEntry(journal, entryOfRows(row, byEntry.get(row.entry_id) ?? []));
    }
    return journal;
  });
}
