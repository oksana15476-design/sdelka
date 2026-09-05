import {
  type Account,
  type AccountKind,
  type DealPartiesAttestation,
  type FundsRef,
  type Journal,
  type JournalEntry,
  type JournalEntryInput,
  type JournalEntryKind,
  type Posting,
  DEFAULT_FEE_CEILING,
  accountCode,
  appendEntry,
  clientKey,
  createJournalEntry,
  emptyJournal,
  isClientRef,
  trancheSettlement,
} from '@sdelka/ledger';
import { type CurrencyCode, assertCurrencyCode, compareRational, money } from '@sdelka/money';
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
/* Что схема удержать не может                                               */
/* ------------------------------------------------------------------------- */

/**
 * Поля записи, для которых в `sdelka.ledger_entry` нет колонки. Отказ описан у
 * `DbErrorCode.entryDeclarationNotStorable`: не пишем того, чего не сможем
 * прочесть обратно.
 */
function notStorable(entry: JournalEntry): string | null {
  if (entry.converts !== null) return 'converts';
  if (entry.accrues !== null) return 'accrues';
  if (entry.funds !== null) return 'funds';
  if (entry.settles !== null) {
    // Потолок удержания в схеме не хранится, а умолчанием у `trancheSettlement`
    // стоит жёсткий предел учёта. Значит запись с пределом, равным жёсткому,
    // читается обратно точно, а с более строгим — нет: чтение вернуло бы
    // расчёт, которому разрешено больше, чем было разрешено на самом деле.
    if (compareRational(entry.settles.ceiling.maxShare, DEFAULT_FEE_CEILING.maxShare) !== 0) {
      return 'settles.ceiling';
    }
  }
  return null;
}

export function assertStorableEntry(entry: JournalEntry): void {
  const field = notStorable(entry);
  if (field !== null) {
    throw new DbError(DbErrorCode.entryDeclarationNotStorable, { entryId: entry.id, field });
  }
}

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
/* Колонки → TS                                                              */
/* ------------------------------------------------------------------------- */

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
  const settles =
    row.settles_deal_id === null
      ? {}
      : {
          settles: trancheSettlement(
            { dealId: row.settles_deal_id, trancheId: row.settles_tranche_id ?? '' },
            clientKey(row.settles_payer ?? ''),
            clientKey(row.settles_recipient ?? ''),
            attestationOfRow(row),
          ),
        };
  const corrects =
    row.corrects_entry_id === null ? {} : { correctsEntryId: row.corrects_entry_id };
  const input: JournalEntryInput = { ...base, ...settles, ...corrects };
  // Сборка идёт через **конструктор учёта**, а не литералом. Это и есть второй
  // контур инвариантов на чтении: строка, из которой не собирается запись,
  // поднимает `LedgerError` с тем же ключом, что и при записи, — баланс,
  // отнесение, форма объявления, ссылка исправления.
  return createJournalEntry(input);
}

/* ------------------------------------------------------------------------- */
/* Запись                                                                    */
/* ------------------------------------------------------------------------- */

const INSERT_ENTRY = `
  INSERT INTO sdelka.ledger_entry (
    entry_id, occurred_at, kind, memo_key, corrects_entry_id,
    settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
  SELECT entry_id, occurred_at, kind, memo_key, corrects_entry_id,
         settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref
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
  assertStorableEntry(entry);
  const settles = entry.settles;
  const inserted = await client.query<{ entry_id: string }>(INSERT_ENTRY, [
    entry.id,
    entry.occurredAt,
    entry.kind,
    entry.memoKey,
    entry.correctsEntryId,
    settles?.deal.dealId ?? null,
    settles?.deal.trancheId ?? null,
    settles?.payer ?? null,
    settles?.recipient ?? null,
    settles?.evidenceRef ?? null,
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
  SELECT entry_id, occurred_at, kind, memo_key, corrects_entry_id,
         settles_deal_id, settles_tranche_id, settles_payer, settles_recipient, settles_evidence_ref
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
