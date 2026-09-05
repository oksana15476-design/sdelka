import {
  type ConditionAct,
  type DealStatus,
  type FreezeReason,
  type PartyRef,
  type PayoutLeg,
  type PayoutStatus,
  type ReleaseConditionType,
  type ThawedTrancheStatus,
  type TrancheState,
  type TrancheStatus,
  type WithdrawalStatus,
  DomainError,
  RejectionCode,
  dealState,
  deadline,
  duration,
  frozenTrancheState,
  instant,
  isTerminalTrancheStatus,
  nonTerminalTrancheState,
  terminalTrancheState,
} from '@sdelka/domain';
import { assertCurrencyCode, money } from '@sdelka/money';
import { DbError, DbErrorCode } from '../errors.ts';
import { type PoolClient, toBigInt } from '../pool.ts';
import { translating } from './errors.ts';
import {
  type DealSnapshot,
  type PayoutSnapshot,
  type TrancheSnapshot,
  type WithdrawalSnapshot,
  type WriteOutcome,
  dealSnapshotsSame,
  payoutSnapshotsSame,
  trancheSnapshotsSame,
  withdrawalSnapshotsSame,
} from './port.ts';

/**
 * Состояние сделки, транша, поручения и вывода со счёта клиента.
 *
 * **Как здесь устроена идемпотентность и почему именно так.**
 *
 * Отдельной таблицы «применённые шаги» нет и не будет. Такая таблица — это
 * второй источник истины о том, что произошло: она может разойтись с самими
 * артефактами шага, и тогда «шаг применён» будет означать не «деньги
 * записаны», а «кто-то отметил, что записал». Артефакты шага и есть его след, и
 * у каждого из них уже есть неизменяемый естественный ключ: `entry_id` у записи
 * журнала, пара «цепочка, номер» у записи аудита, пара «сделка, транш» у транша.
 *
 * Отсюда правило, одно на всё хранилище:
 *
 * - **дополняемое** (журнал учёта, журнал аудита) пишется `ON CONFLICT DO
 *   NOTHING`, и при конфликте лежащее сравнивается с записываемым. Совпало —
 *   повтор; не совпало — `db.step.conflict`. Одного `DO NOTHING` мало: он
 *   одинаково молчит и о повторе, и о подмене;
 * - **изменяемое** (состояние) пишется сверкой с предыдущим: шаг объявляет, из
 *   какого состояния уходит, и обновление происходит только если в базе лежит
 *   ровно оно (`WHERE (…) IS NOT DISTINCT FROM (…)`). Это замена колонки версии,
 *   которой в схеме нет. Если обновление не задело ни строки, разбирается, что
 *   лежит на самом деле: цель шага — повтор; что угодно другое —
 *   `db.step.state_conflict`.
 *
 * Строгость здесь не в том, чтобы повтор «прошёл», а в том, что **повтор и
 * гонка различимы**. Слепой `UPDATE` без сверки выигрывает последним
 * записавшим и теряет чужой шаг молча; `INSERT … ON CONFLICT DO UPDATE`
 * делает то же самое, только выглядит аккуратно.
 */

/* ------------------------------------------------------------------------- */
/* Сторона                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Сторона пишется вместе с тем, кто на неё ссылается: `party` — таблица
 * справочная, отдельного шага «завести сторону» у мира нет. Обе половины
 * `PartyRef` кладутся одной строкой — врозь их взять неоткуда (`0004`).
 *
 * Повтор с другим ключом счёта — конфликт: одно лицо не может иметь двух
 * счетов, иначе деньги и профиль разъезжаются.
 */
async function saveParty(client: PoolClient, ref: PartyRef): Promise<void> {
  const inserted = await client.query<{ account_key: string }>(
    `INSERT INTO sdelka.party (party_id, account_key) VALUES ($1,$2)
     ON CONFLICT (party_id) DO NOTHING
     RETURNING account_key`,
    [ref.partyId, ref.accountKey],
  );
  if (inserted.rowCount !== 0) return;
  const existing = await client.query<{ account_key: string }>(
    `SELECT account_key FROM sdelka.party WHERE party_id = $1`,
    [ref.partyId],
  );
  if (existing.rows[0]?.account_key !== ref.accountKey) {
    throw new DbError(DbErrorCode.stepConflict, { relation: 'party', id: ref.partyId });
  }
}

/* ------------------------------------------------------------------------- */
/* Сделка                                                                    */
/* ------------------------------------------------------------------------- */

interface DealRow {
  readonly deal_id: string;
  readonly status: string;
  readonly buyer_party_id: string;
  readonly buyer_account_key: string;
  readonly seller_party_id: string;
  readonly seller_account_key: string;
}

const SELECT_DEAL = `
  SELECT d.deal_id, d.status,
         d.buyer_party_id, b.account_key AS buyer_account_key,
         d.seller_party_id, s.account_key AS seller_account_key
    FROM sdelka.deal d
    JOIN sdelka.party b ON b.party_id = d.buyer_party_id
    JOIN sdelka.party s ON s.party_id = d.seller_party_id
   WHERE d.deal_id = $1`;

function dealOfRow(row: DealRow): DealSnapshot {
  return Object.freeze({
    dealId: row.deal_id,
    state: dealState(row.status as DealStatus),
    buyer: Object.freeze({ partyId: row.buyer_party_id, accountKey: row.buyer_account_key }),
    seller: Object.freeze({ partyId: row.seller_party_id, accountKey: row.seller_account_key }),
  });
}

export async function loadDeal(
  client: PoolClient,
  dealId: string,
): Promise<DealSnapshot | null> {
  return translating(async () => {
    const result = await client.query<DealRow>(SELECT_DEAL, [dealId]);
    const row = result.rows[0];
    return row === undefined ? null : dealOfRow(row);
  });
}

export async function saveDeal(
  client: PoolClient,
  snapshot: DealSnapshot,
): Promise<WriteOutcome> {
  return translating(async () => {
    await saveParty(client, snapshot.buyer);
    await saveParty(client, snapshot.seller);
    const inserted = await client.query(
      `INSERT INTO sdelka.deal (deal_id, status, buyer_party_id, seller_party_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (deal_id) DO NOTHING`,
      [snapshot.dealId, snapshot.state.status, snapshot.buyer.partyId, snapshot.seller.partyId],
    );
    if (inserted.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
    const existing = await loadDeal(client, snapshot.dealId);
    if (existing !== null && dealSnapshotsSame(existing, snapshot)) {
      return Object.freeze({ written: 0, repeated: 1 });
    }
    // Стороны сделки не меняются, статус меняется. Поэтому обновление только
    // статуса и только у сделки с теми же сторонами: подмена стороны у
    // заведённой сделки — не шаг, а другая сделка под тем же номером.
    if (
      existing === null ||
      existing.buyer.partyId !== snapshot.buyer.partyId ||
      existing.seller.partyId !== snapshot.seller.partyId
    ) {
      throw new DbError(DbErrorCode.stepConflict, { relation: 'deal', id: snapshot.dealId });
    }
    await client.query(`UPDATE sdelka.deal SET status = $2 WHERE deal_id = $1`, [
      snapshot.dealId,
      snapshot.state.status,
    ]);
    return Object.freeze({ written: 1, repeated: 0 });
  });
}

/* ------------------------------------------------------------------------- */
/* Транш                                                                     */
/* ------------------------------------------------------------------------- */

interface TrancheRow {
  readonly deal_id: string;
  readonly tranche_id: string;
  readonly status: string;
  readonly deadline_at: Date | null;
  readonly entered_at: Date | null;
  readonly suspended_from: string | null;
  readonly remaining_ms: string | null;
  readonly freeze_reason: string | null;
  readonly frozen_by: string | null;
  readonly required_amount_minor: string | null;
  readonly required_currency: string | null;
  readonly act_agreed_at: Date | null;
  readonly act_recipient_party_id: string | null;
  readonly act_recipient_account_key: string | null;
  readonly act_text_version: string | null;
  readonly act_condition_type: string | null;
}

const SELECT_TRANCHE = `
  SELECT t.deal_id, t.tranche_id, t.status, t.deadline_at, t.entered_at,
         t.suspended_from, t.remaining_ms, t.freeze_reason, t.frozen_by,
         t.required_amount_minor, t.required_currency,
         a.agreed_at AS act_agreed_at,
         a.recipient_party_id AS act_recipient_party_id,
         p.account_key AS act_recipient_account_key,
         a.condition_text_version AS act_text_version,
         a.condition_type AS act_condition_type
    FROM sdelka.tranche t
    LEFT JOIN sdelka.condition_act a
      ON a.deal_id = t.deal_id AND a.tranche_id = t.tranche_id
     AND a.agreed_at = t.condition_act_agreed_at
    LEFT JOIN sdelka.party p ON p.party_id = a.recipient_party_id
   WHERE t.deal_id = $1 AND t.tranche_id = $2`;

function actOfRow(row: TrancheRow): ConditionAct | null {
  if (row.act_agreed_at === null || row.act_recipient_party_id === null) return null;
  return Object.freeze({
    recipient: Object.freeze({
      partyId: row.act_recipient_party_id,
      accountKey: row.act_recipient_account_key ?? '',
    }),
    agreedAt: instant(row.act_agreed_at.getTime()),
    conditionTextVersion: row.act_text_version ?? '',
    conditionType: row.act_condition_type as ReleaseConditionType,
  });
}

/**
 * Состояние транша из строки.
 *
 * Собирается **конструкторами домена**, а не литералом: у `TrancheState` три
 * варианта союза, и каждый из них домен собирает со своими проверками
 * (`assertConditionAct` — состояние после `pending` без акта не существует).
 * Строка, из которой законного состояния не выходит, поднимает `DomainError` с
 * тем же ключом, что и попытка собрать такое состояние в коде.
 */
function trancheStateOfRow(row: TrancheRow): TrancheState {
  const status = row.status as TrancheStatus;
  if (isTerminalTrancheStatus(status)) return terminalTrancheState(status);
  const act = actOfRow(row);
  const enteredAt = instant((row.entered_at ?? new Date(0)).getTime());
  if (status === 'frozen') {
    return frozenTrancheState(
      row.suspended_from as ThawedTrancheStatus,
      duration(Number(toBigInt(row.remaining_ms ?? '0'))),
      enteredAt,
      act,
      row.freeze_reason as FreezeReason,
      row.frozen_by ?? '',
    );
  }
  return nonTerminalTrancheState(
    status as ThawedTrancheStatus,
    deadline(instant((row.deadline_at ?? new Date(0)).getTime())),
    enteredAt,
    act,
  );
}

function trancheOfRow(row: TrancheRow): TrancheSnapshot {
  return Object.freeze({
    dealId: row.deal_id,
    trancheId: row.tranche_id,
    state: trancheStateOfRow(row),
    required:
      row.required_amount_minor === null || row.required_currency === null
        ? null
        : money(assertCurrencyCode(row.required_currency), toBigInt(row.required_amount_minor)),
  });
}

export async function loadTranche(
  client: PoolClient,
  dealId: string,
  trancheId: string,
): Promise<TrancheSnapshot | null> {
  return translating(async () => {
    const result = await client.query<TrancheRow>(SELECT_TRANCHE, [dealId, trancheId]);
    const row = result.rows[0];
    return row === undefined ? null : trancheOfRow(row);
  });
}

/** Колонки состояния — построчное зеркало трёх вариантов союза `TrancheState`. */
interface TrancheColumns {
  readonly deadlineAt: string | null;
  readonly enteredAt: string | null;
  readonly suspendedFrom: string | null;
  readonly remainingMs: string | null;
  readonly freezeReason: string | null;
  readonly frozenBy: string | null;
}

function trancheColumns(state: TrancheState): TrancheColumns {
  const empty: TrancheColumns = {
    deadlineAt: null,
    enteredAt: null,
    suspendedFrom: null,
    remainingMs: null,
    freezeReason: null,
    frozenBy: null,
  };
  if (!('enteredAt' in state)) return empty;
  const enteredAt = new Date(state.enteredAt).toISOString();
  if (state.status === 'frozen') {
    return {
      ...empty,
      enteredAt,
      suspendedFrom: state.suspendedFrom,
      remainingMs: String(state.remaining),
      freezeReason: state.reason,
      frozenBy: state.frozenBy,
    };
  }
  return { ...empty, enteredAt, deadlineAt: new Date(state.deadline.at).toISOString() };
}

/**
 * Акт получателя — строка `condition_act`, на которую транш ссылается внешним
 * ключом. Пишется до транша: наличие акта в этой схеме не флаг, а ссылка.
 */
async function saveConditionAct(
  client: PoolClient,
  dealId: string,
  trancheId: string,
  act: ConditionAct,
): Promise<void> {
  await saveParty(client, act.recipient);
  const inserted = await client.query(
    `INSERT INTO sdelka.condition_act (
       deal_id, tranche_id, recipient_party_id, agreed_at, condition_text_version, condition_type
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (deal_id, tranche_id) DO NOTHING`,
    [
      dealId,
      trancheId,
      act.recipient.partyId,
      new Date(act.agreedAt).toISOString(),
      act.conditionTextVersion,
      act.conditionType,
    ],
  );
  if (inserted.rowCount !== 0) return;
  // Акт уже лежит. `DO NOTHING` в одиночку здесь был бы дырой: он одинаково
  // молчит и о повторе того же акта, и о подмене акта у транша, где деньги уже
  // приняты. Второе домен называет поимённо (`domain.condition_act.substituted`,
  // `CORE.md` Ф13) — тем же ключом отвечает и хранилище.
  const existing = await client.query<{
    recipient_party_id: string;
    agreed_at: Date;
    condition_text_version: string;
    condition_type: string;
  }>(
    `SELECT recipient_party_id, agreed_at, condition_text_version, condition_type
       FROM sdelka.condition_act WHERE deal_id = $1 AND tranche_id = $2`,
    [dealId, trancheId],
  );
  const row = existing.rows[0];
  const same =
    row !== undefined &&
    row.recipient_party_id === act.recipient.partyId &&
    row.agreed_at.getTime() === act.agreedAt &&
    row.condition_text_version === act.conditionTextVersion &&
    row.condition_type === act.conditionType;
  if (!same) {
    throw new DomainError(RejectionCode.conditionActSubstituted);
  }
}

export async function saveTranche(
  client: PoolClient,
  snapshot: TrancheSnapshot,
  previous: TrancheSnapshot | null,
): Promise<WriteOutcome> {
  return translating(async () => {
    const act = 'conditionAct' in snapshot.state ? snapshot.state.conditionAct : null;
    if (act !== null) {
      await saveConditionAct(client, snapshot.dealId, snapshot.trancheId, act);
    }
    const columns = trancheColumns(snapshot.state);
    const amount = snapshot.required;
    const values = [
      snapshot.dealId,
      snapshot.trancheId,
      snapshot.state.status,
      columns.deadlineAt,
      columns.enteredAt,
      columns.suspendedFrom,
      columns.remainingMs,
      columns.freezeReason,
      columns.frozenBy,
      amount === null ? null : amount.minor.toString(),
      amount?.currency ?? null,
      act === null ? null : new Date(act.agreedAt).toISOString(),
    ];
    if (previous === null) {
      const inserted = await client.query(
        `INSERT INTO sdelka.tranche (
           deal_id, tranche_id, status, deadline_at, entered_at,
           suspended_from, remaining_ms, freeze_reason, frozen_by,
           required_amount_minor, required_currency, condition_act_agreed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (deal_id, tranche_id) DO NOTHING`,
        values,
      );
      if (inserted.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
      return repeatOrConflict(client, snapshot);
    }
    // Сверка с предыдущим состоянием — построчная, по всем колонкам состояния.
    // `IS NOT DISTINCT FROM` вместо `=`, потому что половина колонок `NULL` в
    // каждом варианте союза, а `NULL = NULL` в SQL не истина.
    //
    // `COALESCE` у ссылки на акт — не удобство. Терминальный вариант союза
    // `TrancheState` акта не несёт вовсе, а `0004_deal_tranche.sql` объявляет
    // расхождение с TS прямо: «здесь он остаётся. Акт — история транша, а не
    // его текущее состояние, и стирать его в момент расчёта значило бы терять
    // основание, ради которого весь механизм и построен». Поэтому переход в
    // терминальное состояние ссылку не трогает.
    const before = trancheColumns(previous.state);
    const updated = await client.query(
      `UPDATE sdelka.tranche SET
         status = $3, deadline_at = $4, entered_at = $5,
         suspended_from = $6, remaining_ms = $7, freeze_reason = $8, frozen_by = $9,
         required_amount_minor = $10, required_currency = $11,
         condition_act_agreed_at = COALESCE($12::timestamptz, condition_act_agreed_at)
       WHERE deal_id = $1 AND tranche_id = $2
         AND status = $13
         AND deadline_at IS NOT DISTINCT FROM $14::timestamptz
         AND entered_at IS NOT DISTINCT FROM $15::timestamptz
         AND suspended_from IS NOT DISTINCT FROM $16::sdelka.tranche_status
         AND remaining_ms IS NOT DISTINCT FROM $17::bigint
         AND freeze_reason IS NOT DISTINCT FROM $18::sdelka.freeze_reason
         AND frozen_by IS NOT DISTINCT FROM $19`,
      [
        ...values,
        previous.state.status,
        before.deadlineAt,
        before.enteredAt,
        before.suspendedFrom,
        before.remainingMs,
        before.freezeReason,
        before.frozenBy,
      ],
    );
    if (updated.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
    return repeatOrConflict(client, snapshot);
  });
}

/**
 * Обновление не задело ни строки. Два объяснения, и они разные по последствиям:
 * либо шаг уже применён (в базе лежит его цель — повтор), либо там лежит чужое
 * состояние (гонка или потерянный шаг — отказ с именем).
 */
async function repeatOrConflict(
  client: PoolClient,
  snapshot: TrancheSnapshot,
): Promise<WriteOutcome> {
  const current = await loadTranche(client, snapshot.dealId, snapshot.trancheId);
  if (current !== null && trancheSnapshotsSame(current, snapshot)) {
    return Object.freeze({ written: 0, repeated: 1 });
  }
  throw new DbError(DbErrorCode.stepStateConflict, {
    relation: 'tranche',
    id: `${snapshot.dealId}:${snapshot.trancheId}`,
    expected: snapshot.state.status,
    actual: current?.state.status ?? '',
  });
}

/* ------------------------------------------------------------------------- */
/* Поручение                                                                 */
/* ------------------------------------------------------------------------- */

interface PayoutRow {
  readonly payout_id: string;
  readonly deal_id: string;
  readonly tranche_id: string;
  readonly status: string;
  readonly leg: string;
  readonly idempotency_key: string;
  readonly evidence_bundle_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly beneficiary_party_id: string;
  readonly beneficiary_account_key: string;
  readonly provider_reference: string | null;
}

const SELECT_PAYOUTS = `
  SELECT o.payout_id, o.deal_id, o.tranche_id, o.status, o.leg, o.idempotency_key,
         o.evidence_bundle_id, o.amount_minor, o.currency,
         o.beneficiary_party_id, p.account_key AS beneficiary_account_key,
         o.provider_reference
    FROM sdelka.payout o
    JOIN sdelka.party p ON p.party_id = o.beneficiary_party_id
   WHERE o.deal_id = $1 AND o.tranche_id = $2
   ORDER BY o.payout_id`;

function payoutOfRow(row: PayoutRow): PayoutSnapshot {
  return Object.freeze({
    payoutId: row.payout_id,
    dealId: row.deal_id,
    state: Object.freeze({
      status: row.status as PayoutStatus,
      idempotencyKey: row.idempotency_key,
      trancheId: row.tranche_id,
      leg: row.leg as PayoutLeg,
    }),
    amount: money(assertCurrencyCode(row.currency), toBigInt(row.amount_minor)),
    beneficiary: Object.freeze({
      partyId: row.beneficiary_party_id,
      accountKey: row.beneficiary_account_key,
    }),
    evidenceBundleId: row.evidence_bundle_id,
    providerReference: row.provider_reference,
  });
}

export async function loadPayouts(
  client: PoolClient,
  dealId: string,
  trancheId: string,
): Promise<readonly PayoutSnapshot[]> {
  return translating(async () => {
    const result = await client.query<PayoutRow>(SELECT_PAYOUTS, [dealId, trancheId]);
    return Object.freeze(result.rows.map(payoutOfRow));
  });
}

export async function savePayout(
  client: PoolClient,
  snapshot: PayoutSnapshot,
  previous: PayoutSnapshot | null,
): Promise<WriteOutcome> {
  return translating(async () => {
    await saveParty(client, snapshot.beneficiary);
    if (previous === null) {
      const inserted = await client.query(
        `INSERT INTO sdelka.payout (
           payout_id, deal_id, tranche_id, status, leg, idempotency_key,
           evidence_bundle_id, amount_minor, currency, beneficiary_party_id, provider_reference
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (payout_id) DO NOTHING`,
        [
          snapshot.payoutId,
          snapshot.dealId,
          snapshot.state.trancheId,
          snapshot.state.status,
          snapshot.state.leg,
          snapshot.state.idempotencyKey,
          snapshot.evidenceBundleId,
          snapshot.amount.minor.toString(),
          snapshot.amount.currency,
          snapshot.beneficiary.partyId,
          snapshot.providerReference,
        ],
      );
      if (inserted.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
      return payoutRepeatOrConflict(client, snapshot);
    }
    // Меняется только статус и ссылка на ответ провайдера: всё остальное —
    // тождество поручения. Ключ идемпотентности функция транша и ноги, сумма и
    // получатель заданы решением, пакет доказательств — основанием (красная
    // линия №5). Поручение, у которого поменялась любая из этих величин, —
    // другое поручение, а не следующий шаг того же.
    const updated = await client.query(
      `UPDATE sdelka.payout SET status = $2, provider_reference = $3
        WHERE payout_id = $1
          AND status = $4
          AND provider_reference IS NOT DISTINCT FROM $5
          AND deal_id = $6 AND tranche_id = $7 AND leg = $8
          AND idempotency_key = $9 AND evidence_bundle_id = $10
          AND amount_minor = $11 AND currency = $12 AND beneficiary_party_id = $13`,
      [
        snapshot.payoutId,
        snapshot.state.status,
        snapshot.providerReference,
        previous.state.status,
        previous.providerReference,
        snapshot.dealId,
        snapshot.state.trancheId,
        snapshot.state.leg,
        snapshot.state.idempotencyKey,
        snapshot.evidenceBundleId,
        snapshot.amount.minor.toString(),
        snapshot.amount.currency,
        snapshot.beneficiary.partyId,
      ],
    );
    if (updated.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
    return payoutRepeatOrConflict(client, snapshot);
  });
}

async function payoutRepeatOrConflict(
  client: PoolClient,
  snapshot: PayoutSnapshot,
): Promise<WriteOutcome> {
  const all = await loadPayouts(client, snapshot.dealId, snapshot.state.trancheId);
  const current = all.find((item) => item.payoutId === snapshot.payoutId) ?? null;
  if (current !== null && payoutSnapshotsSame(current, snapshot)) {
    return Object.freeze({ written: 0, repeated: 1 });
  }
  throw new DbError(DbErrorCode.stepStateConflict, {
    relation: 'payout',
    id: snapshot.payoutId,
    expected: snapshot.state.status,
    actual: current?.state.status ?? '',
  });
}

/* ------------------------------------------------------------------------- */
/* Вывод со счёта клиента                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Вывод — четвёртая часть состояния, и до сих пор единственная, которой у порта
 * не было вовсе. Таблица (`0005_payout.sql`) и машина из шести состояний
 * (`domain/src/client-account.ts`) существовали, метода не было: всё, что не
 * ложилось, порт называл значением или отказом с ключом, а вывод не возвращал
 * ничего.
 *
 * Правило записи то же, что у транша и поручения, и повторено не по инерции:
 * меняется **только статус**, всё остальное — тождество вывода. Сторона, сумма,
 * ключ идемпотентности (`withdrawalIdempotencyKey`, функция номера вывода) и
 * отпечаток счёта-источника заданы в момент заявки; вывод, у которого поменялась
 * любая из них, — другой вывод под тем же номером, а не следующий шаг того же.
 * Для отпечатка это прямо красная линия №9: подменённый на пути
 * `requested → approved` счёт-источник — это перевод не тому.
 */
interface WithdrawalRow {
  readonly withdrawal_id: string;
  readonly party_id: string;
  readonly party_account_key: string;
  readonly status: string;
  readonly idempotency_key: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly source_account_fingerprint: string;
}

const WITHDRAWAL_SOURCE = `
  SELECT w.withdrawal_id, w.party_id, p.account_key AS party_account_key, w.status,
         w.idempotency_key, w.amount_minor, w.currency, w.source_account_fingerprint
    FROM sdelka.withdrawal w
    JOIN sdelka.party p ON p.party_id = w.party_id`;

const SELECT_WITHDRAWALS_BY_PARTY = `${WITHDRAWAL_SOURCE}
   WHERE w.party_id = $1
   ORDER BY w.withdrawal_id`;

const SELECT_WITHDRAWAL_BY_ID = `${WITHDRAWAL_SOURCE}
   WHERE w.withdrawal_id = $1`;

function withdrawalOfRow(row: WithdrawalRow): WithdrawalSnapshot {
  return Object.freeze({
    state: Object.freeze({
      status: row.status as WithdrawalStatus,
      withdrawalId: row.withdrawal_id,
      idempotencyKey: row.idempotency_key,
    }),
    party: Object.freeze({ partyId: row.party_id, accountKey: row.party_account_key }),
    amount: money(assertCurrencyCode(row.currency), toBigInt(row.amount_minor)),
    sourceAccountFingerprint: row.source_account_fingerprint,
  });
}

export async function loadWithdrawals(
  client: PoolClient,
  partyId: string,
): Promise<readonly WithdrawalSnapshot[]> {
  return translating(async () => {
    const result = await client.query<WithdrawalRow>(SELECT_WITHDRAWALS_BY_PARTY, [partyId]);
    return Object.freeze(result.rows.map(withdrawalOfRow));
  });
}

export async function saveWithdrawal(
  client: PoolClient,
  snapshot: WithdrawalSnapshot,
  previous: WithdrawalSnapshot | null,
): Promise<WriteOutcome> {
  return translating(async () => {
    await saveParty(client, snapshot.party);
    if (previous === null) {
      const inserted = await client.query(
        `INSERT INTO sdelka.withdrawal (
           withdrawal_id, party_id, status, idempotency_key,
           amount_minor, currency, source_account_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (withdrawal_id) DO NOTHING`,
        [
          snapshot.state.withdrawalId,
          snapshot.party.partyId,
          snapshot.state.status,
          snapshot.state.idempotencyKey,
          snapshot.amount.minor.toString(),
          snapshot.amount.currency,
          snapshot.sourceAccountFingerprint,
        ],
      );
      if (inserted.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
      return withdrawalRepeatOrConflict(client, snapshot);
    }
    // Тождество вывода стоит в `WHERE` целиком, а не сверяется отдельной
    // проверкой до запроса: сверка «в коде» читает то, что уже могло измениться,
    // и между чтением и записью помещается чужой шаг. Здесь сравнение и запись
    // — один оператор, а несовпадение разбирается тем же способом, что у
    // транша: цель шага уже лежит — повтор, лежит другое — отказ с именем.
    const updated = await client.query(
      `UPDATE sdelka.withdrawal SET status = $2
        WHERE withdrawal_id = $1
          AND status = $3
          AND party_id = $4
          AND idempotency_key = $5
          AND amount_minor = $6
          AND currency = $7
          AND source_account_fingerprint = $8`,
      [
        snapshot.state.withdrawalId,
        snapshot.state.status,
        previous.state.status,
        snapshot.party.partyId,
        snapshot.state.idempotencyKey,
        snapshot.amount.minor.toString(),
        snapshot.amount.currency,
        snapshot.sourceAccountFingerprint,
      ],
    );
    if (updated.rowCount !== 0) return Object.freeze({ written: 1, repeated: 0 });
    return withdrawalRepeatOrConflict(client, snapshot);
  });
}

/**
 * Разбор по номеру вывода, а не по стороне.
 *
 * Чтение по стороне здесь не годится: конфликт бывает и такой, где в базе под
 * тем же номером лежит вывод **другого** клиента, — по стороне из снимка он не
 * нашёлся бы, и отказ доложил бы «в базе ничего» вместо «в базе чужое».
 */
async function withdrawalRepeatOrConflict(
  client: PoolClient,
  snapshot: WithdrawalSnapshot,
): Promise<WriteOutcome> {
  const result = await client.query<WithdrawalRow>(SELECT_WITHDRAWAL_BY_ID, [
    snapshot.state.withdrawalId,
  ]);
  const row = result.rows[0];
  const current = row === undefined ? null : withdrawalOfRow(row);
  if (current !== null && withdrawalSnapshotsSame(current, snapshot)) {
    return Object.freeze({ written: 0, repeated: 1 });
  }
  throw new DbError(DbErrorCode.stepStateConflict, {
    relation: 'withdrawal',
    id: snapshot.state.withdrawalId,
    expected: snapshot.state.status,
    actual: current?.state.status ?? '',
  });
}
