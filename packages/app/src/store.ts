import type { AuditChain, AuditRecord } from '@sdelka/audit';
import {
  type DealState,
  type PartyRef,
  type PayoutLeg,
  type PayoutState,
  type TrancheState,
  boundConditionAct,
} from '@sdelka/domain';
import type { Journal, JournalEntry } from '@sdelka/ledger';
import { type CurrencyCode, type Money, split } from '@sdelka/money';
import {
  type DealRuntime,
  type InvariantSurface,
  type InvariantViolation,
  type TrancheRuntime,
  type World,
  surfaceViolations,
} from './world';

/**
 * Подключение шага мира к хранилищу.
 *
 * **Что здесь чинится.** Порт хранилища есть (`packages/db/src/store/**`):
 * транзакция, журнал проводок, цепочка аудита, снимки, перевод отказов базы в
 * ошибки с теми же ключами. Потребителя у него не было: `flow.ts` держал мир
 * только в памяти, и мир умирал вместе с процессом. Хранилище, в которое никто
 * не пишет, проверено ровно настолько же, насколько инвариант, который никто не
 * зовёт, — то есть никак.
 *
 * **Три правила, которые здесь держатся структурой, а не дисциплиной.**
 *
 * 1. *Запечатывание остаётся единственным входом в новый мир.* Дельта шага
 *    (`stepDelta`) строится **из двух значений `World`**, а `World` собирается
 *    только `sealed`/`recorded` (`world.ts`, `worldBrand`). Значит записать
 *    можно ровно то, что уже прошло проверку инвариантов: «сначала проверили,
 *    потом записали» выражено типом аргумента, а не порядком строк.
 * 2. *Отказ базы — такая же остановка шага, как отказ инварианта.* Шаг
 *    выполняется, запечатывается и **только потом** открывается транзакция;
 *    новый мир возвращается вызывающему исключительно из `stepWorld`. Если
 *    запись не прошла, наружу летит ошибка хранилища и нового мира у
 *    вызывающего нет вовсе — как при `AppInvariantError`. «Записали, потом
 *    заметили» невыразимо: значение возвращается после записи, а не до.
 * 3. *Хранилище — порт, а не зависимость.* `@sdelka/app` не зависит от
 *    `@sdelka/db` ни одной строкой; интерфейс объявлен здесь, над общим
 *    словарём (`@sdelka/audit`, `@sdelka/domain`, `@sdelka/ledger`,
 *    `@sdelka/money`), и реализация подставляется снаружи. Мир без хранилища
 *    работает по-прежнему: шаги `flow.ts` синхронны и хранилища не знают, а
 *    `WITHOUT_STORE` — явно названный, а не подразумеваемый молчанием, режим.
 */

/* ------------------------------------------------------------------------- */
/* Порт                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * ⚠ **Объявление порта повторяет `packages/db/src/store/port.ts` дословно, и
 * это названное расхождение, а не копипаста по невнимательности.**
 *
 * Порт объявлен в `@sdelka/db` — там он появился раньше и там же обоснован:
 * ребро `@sdelka/db → @sdelka/app` перевернуло бы слои и затащило
 * `@sdelka/compliance` с `@sdelka/oracle` в граф сборки команды `pnpm
 * db:migrate`. Обратное ребро (`@sdelka/app → @sdelka/db`) слои не переворачивает,
 * но тащит `pg` в зависимости слоя приложения ради одного интерфейса, у
 * которого нет ни строчки SQL. Тот же файл называет правильный выход и
 * помечает его **[открыто]**: «когда шагу мира понадобится писать самому, тип,
 * который он примет аргументом, обязан быть объявлен над тем же общим
 * словарём; вынести его тогда в отдельный пакет — решение владельца, а не
 * наше».
 *
 * Момент настал. Решение владельца не принято, поэтому объявление стоит здесь,
 * а **расхождение двух объявлений ловится проверкой типов**, а не обещанием:
 * `packages/e2e/test/store-port.test.ts` присваивает одно другому в обе
 * стороны, и любое расхождение в форме порта роняет `pnpm -r typecheck`.
 * Копия, за которой никто не следит, разошлась бы с оригиналом на первой
 * правке; эта — не разойдётся молча.
 */

/** Сколько строк появилось и сколько уже лежало **тем же самым**. */
export interface WriteOutcome {
  readonly written: number;
  readonly repeated: number;
}

export const EMPTY_WRITE: WriteOutcome = Object.freeze({ written: 0, repeated: 0 });

export function addWrites(left: WriteOutcome, right: WriteOutcome): WriteOutcome {
  return Object.freeze({
    written: left.written + right.written,
    repeated: left.repeated + right.repeated,
  });
}

export interface DealSnapshot {
  readonly dealId: string;
  readonly state: DealState;
  readonly buyer: PartyRef;
  readonly seller: PartyRef;
}

export interface TrancheSnapshot {
  readonly dealId: string;
  readonly trancheId: string;
  readonly state: TrancheState;
  readonly required: Money<CurrencyCode> | null;
}

export interface PayoutSnapshot {
  readonly payoutId: string;
  readonly dealId: string;
  readonly state: PayoutState;
  readonly amount: Money<CurrencyCode>;
  readonly beneficiary: PartyRef;
  readonly evidenceBundleId: string;
  readonly providerReference: string | null;
}

export interface WorldStore {
  transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T>;
}

export interface WorldTransaction {
  appendJournal(entries: readonly JournalEntry[]): Promise<WriteOutcome>;
  readJournal(): Promise<Journal>;
  appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome>;
  readChain(chainId: string): Promise<AuditChain>;
  saveDeal(snapshot: DealSnapshot): Promise<WriteOutcome>;
  loadDeal(dealId: string): Promise<DealSnapshot | null>;
  saveTranche(snapshot: TrancheSnapshot, previous: TrancheSnapshot | null): Promise<WriteOutcome>;
  loadTranche(dealId: string, trancheId: string): Promise<TrancheSnapshot | null>;
  savePayout(snapshot: PayoutSnapshot, previous: PayoutSnapshot | null): Promise<WriteOutcome>;
  loadPayouts(dealId: string, trancheId: string): Promise<readonly PayoutSnapshot[]>;
}

/**
 * Мир без хранилища — **названный** режим, а не отсутствующий аргумент.
 *
 * `store?: WorldStore` или `WorldStore | null` означали бы, что «не писать» —
 * это умолчание, до которого можно докатиться, забыв параметр. Здесь до него
 * можно только дойти, написав слово: пропуск аргумента не собирается. Тот же
 * приём, что у `createRefundPayout` в домене, и по той же причине — молчаливого
 * варианта у такого выбора быть не должно.
 */
export const WITHOUT_STORE = Object.freeze({ kind: 'without_store' as const });
export type StoreOption = WorldStore | typeof WITHOUT_STORE;

function storeOf(option: StoreOption): WorldStore | null {
  return 'transact' in option ? option : null;
}

/* ------------------------------------------------------------------------- */
/* Чего у хранилища нет                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Часть шага, которой в хранилище нет места.
 *
 * Возвращается **значением**, а не проглатывается: та же форма, что у
 * `SuppressedEntry` в мире, и по той же причине. Шаг, часть которого не легла в
 * базу, обязан отличаться от шага, который лёг целиком, — иначе «сохранили»
 * будет означать «сохранили то, для чего нашлась колонка», и узнается это через
 * месяц из отчётности.
 *
 * Причина — **ключ**, а не текст: три языка (`CLAUDE.md`).
 */
export interface UnmappedPart {
  readonly subject: string;
  readonly reasonKey: string;
}

/**
 * Закрытый перечень причин. Пополняется только вместе с разбором, что именно
 * потерялось: строка со свободным текстом здесь превратила бы список находок в
 * шум за две недели.
 */
export const UNMAPPED_REASONS = [
  /** У сделки нет обеих сторон: покупатель приходит с траншем, продавец — с актом. */
  'deal.parties_unknown',
  /** Два транша одной сделки называют разных покупателей: у схемы покупатель один. */
  'deal.buyer_ambiguous',
  /** Состояние сделки в приложении шире строки таблицы: акт, объект, заявления, разбор отката. */
  'deal.runtime_not_storable',
  /** Изменились факты приложения, а не состояние автомата: колонок под них нет. */
  'tranche.facts_not_storable',
  /**
   * Красная линия №5 в схеме: `payout.evidence_bundle_id NOT NULL`. У возврата
   * покупателю пакета доказательств нет и быть не обязано — возвращаются
   * собственные деньги плательщика (`flow.ts`, `enqueue_outbound_refund`).
   * Поручение на возврат в базу поэтому не ложится вовсе.
   */
  'payout.evidence_bundle_missing',
  /** Получателя расчёта называет акт об условии; без акта поручение не описать. */
  'payout.beneficiary_unknown',
  /** У порта нет метода: очередь разбора, уведомления, сессии, следы действий. */
  'port.no_method',
  /** У порта нет перечисления: поднять можно только то, чей идентификатор известен. */
  'port.no_listing',
  /** Проверка требует факта приложения, которого в схеме нет. */
  'invariant.not_checkable',
] as const;

export type UnmappedReason = (typeof UNMAPPED_REASONS)[number];

function unmapped(subject: string, reasonKey: UnmappedReason): UnmappedPart {
  return Object.freeze({ subject, reasonKey });
}

/* ------------------------------------------------------------------------- */
/* Мир → снимки                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Отобразилось в снимок — или не отобразилось, и тогда с названной причиной.
 *
 * Разметка, а не `T | null`: `null` означал бы «снимка нет» и «снимок не
 * понадобился» одновременно, а нам нужно первое **вместе с причиной**. Тот же
 * довод, по которому у порта реестра три исхода, а не значение и `null`.
 */
export type Mapping<T> =
  | { readonly kind: 'mapped'; readonly value: T }
  | { readonly kind: 'unmapped'; readonly part: UnmappedPart };

const mapped = <T>(value: T): Mapping<T> => ({ kind: 'mapped', value });
const missing = <T>(subject: string, reasonKey: UnmappedReason): Mapping<T> => ({
  kind: 'unmapped',
  part: unmapped(subject, reasonKey),
});

/**
 * Получатель расчёта как **сторона**, а не как ключ счёта.
 *
 * Тот же порядок, что у `recipientOf` в мире: сначала акт, привязанный к
 * состоянию (он меняется только амендментом обеих сторон), потом акт из фактов
 * — для `pending`, где привязки ещё нет.
 */
function recipientPartyOf(runtime: TrancheRuntime): PartyRef | null {
  return (boundConditionAct(runtime.state) ?? runtime.facts.conditionAct)?.recipient ?? null;
}

/**
 * Снимок сделки.
 *
 * Обе стороны обязательны — у схемы они `NOT NULL` и различны
 * (`deal_parties_distinct`), потому что сделка без сторон это не сделка. В мире
 * же они лежат врозь: продавца называет акт об условии, покупателя — транш.
 * Пока транша нет, снимка нет тоже, и это не обходится подстановкой: сделка в
 * `draft` действительно ещё не знает, между кем она.
 */
export function dealSnapshotOf(world: World, deal: DealRuntime): Mapping<DealSnapshot> {
  const tranches = deal.trancheIds
    .map((trancheId) => world.tranches.get(trancheId))
    .filter((runtime): runtime is TrancheRuntime => runtime !== undefined);
  const first = tranches[0];
  const seller =
    deal.conditionAct?.recipient ?? (first === undefined ? null : recipientPartyOf(first));
  if (first === undefined || seller === null) {
    return missing(`deal:${deal.dealId}`, 'deal.parties_unknown');
  }
  const buyer = first.facts.buyer;
  if (tranches.some((runtime) => runtime.facts.buyer.partyId !== buyer.partyId)) {
    // Покупатель у сделки один: у схемы он колонка, а не список. Выбрать
    // «первого попавшегося» значило бы записать сделку между теми, кого никто
    // не называл.
    return missing(`deal:${deal.dealId}`, 'deal.buyer_ambiguous');
  }
  return mapped({ dealId: deal.dealId, state: deal.state, buyer, seller });
}

export function trancheSnapshotOf(runtime: TrancheRuntime): TrancheSnapshot {
  return {
    dealId: runtime.dealId,
    trancheId: runtime.trancheId,
    state: runtime.state,
    required: runtime.facts.requiredAmount,
  };
}

/**
 * Идентификатор поручения в хранилище.
 *
 * Ключ идемпотентности сюда не годится в одиночку: он функция транша и ноги, а
 * `payout_id` — первичный ключ. Повторная выплата после отказа несёт **тот же**
 * ключ (`0005_payout.sql`: глобального `UNIQUE` на ключе нет намеренно), и два
 * поручения оказались бы одной строкой. Поэтому к ключу добавляется порядковый
 * номер поручения этой ноги — он детерминирован порядком списка выплат транша,
 * а список только дополняется. Повтор шага даёт тот же идентификатор, и это
 * ровно то, что нужно идемпотентности.
 */
export function payoutIdOf(idempotencyKey: string, ordinal: number): string {
  return `${idempotencyKey}:${ordinal}`;
}

/**
 * Ссылка на ответ провайдера — **из журнала аудита**, а не из отдельного поля.
 *
 * Приложение ответ банка не запоминает: он приезжает в шаг параметром и уходит
 * записью `payout_result`. Заводить рядом второе место хранения значило бы
 * завести два ответа на один вопрос; поэтому ссылка читается оттуда, где она
 * уже лежит.
 *
 * Соответствие «n-е поручение ноги ↔ n-й исход по этому ключу» держится тем же,
 * чем нумерация поручения: оба списка только дополняются.
 *
 * Ограничение `payout_response_only_when_answered` (0018) зеркалится здесь:
 * ссылка возможна только у ответивших статусов. У `unknown` ответа нет по
 * определению — красная линия №8.
 */
function providerReferenceOf(chain: AuditChain, state: PayoutState, ordinal: number): string | null {
  if (state.status !== 'settled' && state.status !== 'rejected') return null;
  const outcomes = chain.records.filter(
    (record) =>
      record.subject.scope === 'payout' &&
      record.subject.id === state.idempotencyKey &&
      record.body.kind === 'payout_result',
  );
  const record = outcomes[ordinal];
  if (record === undefined || record.body.kind !== 'payout_result') return null;
  return record.body.response?.storageRef ?? null;
}

/**
 * Сумма поручения.
 *
 * У возврата — брутто: возвращается всё собранное, без удержания
 * (`domain/src/ids.ts`, `refundIdempotencyKey`). У расчёта — нетто получателя:
 * комиссия уходит платформе той же записью, и поручение в банк несёт то, что
 * действительно уйдёт продавцу.
 */
function payoutAmountOf(runtime: TrancheRuntime, leg: PayoutLeg): Money<CurrencyCode> {
  const gross = runtime.facts.collectedAmount ?? runtime.facts.requiredAmount;
  return leg === 'refund' ? gross : split(gross, runtime.deductions).recipient;
}

export function payoutSnapshotsOf(
  chain: AuditChain,
  runtime: TrancheRuntime,
): readonly Mapping<PayoutSnapshot>[] {
  const ordinals = new Map<string, number>();
  return runtime.payouts.map((state) => {
    const ordinal = ordinals.get(state.idempotencyKey) ?? 0;
    ordinals.set(state.idempotencyKey, ordinal + 1);
    const payoutId = payoutIdOf(state.idempotencyKey, ordinal);
    const beneficiary =
      state.leg === 'refund'
        ? // Красная линия №9: возврат только на счёт-источник, на имя плательщика.
          runtime.facts.buyer
        : recipientPartyOf(runtime);
    if (beneficiary === null) {
      return missing<PayoutSnapshot>(`payout:${payoutId}`, 'payout.beneficiary_unknown');
    }
    const evidenceBundleId = runtime.facts.evidenceBundleId;
    if (evidenceBundleId === null) {
      return missing<PayoutSnapshot>(`payout:${payoutId}`, 'payout.evidence_bundle_missing');
    }
    return mapped({
      payoutId,
      dealId: runtime.dealId,
      state,
      amount: payoutAmountOf(runtime, state.leg),
      beneficiary,
      evidenceBundleId,
      providerReference: providerReferenceOf(chain, state, ordinal),
    });
  });
}

/* ------------------------------------------------------------------------- */
/* Дельта шага                                                               */
/* ------------------------------------------------------------------------- */

export interface TrancheWrite {
  readonly snapshot: TrancheSnapshot;
  /** Состояние, из которого шаг делается. `null` — транша ещё нет. */
  readonly previous: TrancheSnapshot | null;
}

export interface PayoutWrite {
  readonly snapshot: PayoutSnapshot;
  readonly previous: PayoutSnapshot | null;
}

export interface WorldDelta {
  readonly entries: readonly JournalEntry[];
  readonly records: readonly AuditRecord[];
  readonly deals: readonly DealSnapshot[];
  readonly tranches: readonly TrancheWrite[];
  readonly payouts: readonly PayoutWrite[];
  readonly unmapped: readonly UnmappedPart[];
}

/**
 * Равенство снимков — канонический `JSON` над доменными значениями.
 *
 * Тот же приём и тот же довод, что у `sameEntry` в `packages/db`: снимки —
 * замороженные значения без циклов, обе стороны строит **одна и та же**
 * функция, поэтому порядок ключей совпадает, а `bigint` уводится в строку
 * (красная линия №4: плавающей точки не бывает нигде, включая сравнение).
 *
 * Поимённого сравнения полей здесь нет намеренно: оно было бы третьим ответом
 * на вопрос «те же ли это снимки» — после схемы и после `port.ts`, — и первым,
 * который молча пропустил бы новое поле.
 */
function sameSnapshot(left: unknown, right: unknown): boolean {
  const shape = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? `${item}n` : item,
    );
  return shape(left) === shape(right);
}

/**
 * Приписанное к журналу за шаг.
 *
 * Журнал только дополняется, и это проверяется, а не предполагается: если
 * прежние записи перестали быть началом новых, значит журнал переписан, и
 * дописывать в базу нечего — там другая история.
 */
function appended<T>(
  before: readonly T[],
  after: readonly T[],
  key: (item: T) => string,
  what: string,
): readonly T[] {
  if (after.length < before.length) {
    throw new Error(`app.store.rewritten:${what}`);
  }
  for (let index = 0; index < before.length; index += 1) {
    if (key(before[index] as T) !== key(after[index] as T)) {
      throw new Error(`app.store.rewritten:${what}`);
    }
  }
  return after.slice(before.length);
}

/**
 * Что изменилось в мире за шаг — в словаре хранилища.
 *
 * `before === null` означает «в базе нет ничего»: мир кладётся целиком, вместе
 * с записью открытия цепочки. Иначе дельта строится сравнением двух миров, и
 * оба они прошли `sealed` — см. правило 1 в заголовке файла.
 */
export function stepDelta(before: World | null, after: World): WorldDelta {
  const parts: UnmappedPart[] = [];
  const entries = appended(
    before?.journal.entries ?? [],
    after.journal.entries,
    (entry) => entry.id,
    'journal',
  );
  const records = appended(
    before?.chain.records ?? [],
    after.chain.records,
    (record) => `${record.seq}:${record.recordHash}`,
    'chain',
  );

  const deals: DealSnapshot[] = [];
  for (const deal of after.deals.values()) {
    const previousRuntime = before === null ? null : (before.deals.get(deal.dealId) ?? null);
    const snapshot = dealSnapshotOf(after, deal);
    if (snapshot.kind === 'unmapped') {
      if (previousRuntime !== deal) parts.push(snapshot.part);
      continue;
    }
    /*
     * Снимок предыдущего состояния строится по **предыдущему** миру, а не
     * пересчитывается по нынешнему: в базе лежит ровно то, что записал прошлый
     * шаг, и сверка «из чего уходим» обязана сравниваться с ним. Пересчёт по
     * нынешнему миру давал бы то же значение почти всегда — и разошёлся бы
     * ровно в тот раз, когда это важно.
     */
    const previous =
      before === null || previousRuntime === null
        ? null
        : dealSnapshotOf(before, previousRuntime);
    if (
      previous !== null &&
      previous.kind === 'mapped' &&
      sameSnapshot(previous.value, snapshot.value)
    ) {
      // Состояние сделки не изменилось. Если при этом изменилось что-то в её
      // рантайме — акт, объект, заявления, разбор отката, — это и есть то,
      // чего схема не держит, и оно называется вслух.
      if (previousRuntime !== deal) {
        parts.push(unmapped(`deal:${deal.dealId}`, 'deal.runtime_not_storable'));
      }
      continue;
    }
    deals.push(snapshot.value);
  }

  const tranches: TrancheWrite[] = [];
  const payouts: PayoutWrite[] = [];
  for (const runtime of after.tranches.values()) {
    const previousRuntime =
      before === null ? null : (before.tranches.get(runtime.trancheId) ?? null);
    if (previousRuntime === runtime) continue;
    const snapshot = trancheSnapshotOf(runtime);
    const previous = previousRuntime === null ? null : trancheSnapshotOf(previousRuntime);
    if (previous !== null && sameSnapshot(previous, snapshot)) {
      // Автомат стоит на месте, а транш изменился: изменились факты
      // приложения. Колонок под них нет — ни под собранное, ни под подписи, ни
      // под реквизиты, ни под наблюдение.
      parts.push(unmapped(`tranche:${runtime.trancheId}`, 'tranche.facts_not_storable'));
    } else {
      tranches.push({ snapshot, previous });
    }

    const beforePayouts =
      before === null || previousRuntime === null
        ? []
        : payoutSnapshotsOf(before.chain, previousRuntime);
    const afterPayouts = payoutSnapshotsOf(after.chain, runtime);
    afterPayouts.forEach((item, index) => {
      if (item.kind === 'unmapped') {
        parts.push(item.part);
        return;
      }
      const earlier = beforePayouts[index];
      const previousPayout =
        earlier !== undefined && earlier.kind === 'mapped' ? earlier.value : null;
      if (previousPayout !== null && sameSnapshot(previousPayout, item.value)) return;
      payouts.push({ snapshot: item.value, previous: previousPayout });
    });
  }

  for (const part of worldOnlyParts(before, after)) parts.push(part);

  return Object.freeze({
    entries,
    records,
    deals: Object.freeze(deals),
    tranches: Object.freeze(tranches),
    payouts: Object.freeze(payouts),
    unmapped: Object.freeze(parts),
  });
}

/**
 * Части мира, у которых в порту нет метода вовсе.
 *
 * Очередь разбора, уведомления, задачи оракула, сессии и следы действий
 * («кто готовил», «кто вызвал остановку») — всё это состояние, от которого
 * зависят решения о деньгах: разделение обязанностей читает **только** факты
 * мира (`world.ts`, `ActionFact`). После перезапуска процесса их не будет, и
 * Н1/Н5 замолчат. Часть из них имеет таблицы в схеме (`0010_auth.sql`), но не
 * имеет методов у порта; часть не имеет ни того ни другого.
 *
 * Перечисляются только **изменившиеся** за шаг: список всего, чего нет,
 * повторённый на каждом шаге, никто читать не станет.
 */
function worldOnlyParts(before: World | null, after: World): readonly UnmappedPart[] {
  const out: UnmappedPart[] = [];
  const count = (value: readonly unknown[] | ReadonlyMap<unknown, unknown>): number =>
    'length' in value ? value.length : value.size;
  const changed = (
    name: string,
    left: readonly unknown[] | ReadonlyMap<unknown, unknown> | undefined,
    right: readonly unknown[] | ReadonlyMap<unknown, unknown>,
  ): void => {
    // Первая запись сравнивается не с предыдущим миром, а с пустотой: у пустого
    // перечня терять нечего, и называть его потерянным значило бы утопить
    // настоящие находки в списке из восьми строк на каждом первом шаге.
    const lost = left === undefined ? count(right) > 0 : left !== right;
    if (lost) out.push(unmapped(name, 'port.no_method'));
  };
  changed('tasks', before?.tasks, after.tasks);
  changed('observation_tasks', before?.observationTasks, after.observationTasks);
  changed('notifications', before?.notifications, after.notifications);
  changed('suppressed', before?.suppressed, after.suppressed);
  changed('reissued_payouts', before?.reissuedPayouts, after.reissuedPayouts);
  changed('sessions', before?.sessions, after.sessions);
  changed('facts', before?.facts, after.facts);
  changed('anchors', before?.anchors, after.anchors);
  return out;
}

/* ------------------------------------------------------------------------- */
/* Запись шага                                                               */
/* ------------------------------------------------------------------------- */

export interface Written {
  readonly world: World;
  readonly outcome: WriteOutcome;
  /** Что в базу не легло. Пустой список — легло всё. */
  readonly unmapped: readonly UnmappedPart[];
}

/**
 * Порядок внутри транзакции: стороны и сделка, потом транш, потом проводки,
 * потом поручения, и последней — цепочка аудита.
 *
 * Порядок задан ссылочной целостностью схемы: `payout` ссылается на пару
 * «сделка, транш», `tranche` — на сделку и на акт. Журнал внешних ключей на
 * состояние не имеет вовсе, но идёт раньше поручений: сначала деньги, потом
 * распоряжение о них.
 *
 * Всё это внутри **одной** транзакции: шаг мира ложится целиком или не ложится
 * вовсе. Запись о решении без проводки, которую она объясняет, — журнал,
 * который врёт; проводка без записи о решении — деньги без основания.
 */
async function writeDelta(tx: WorldTransaction, delta: WorldDelta): Promise<WriteOutcome> {
  let outcome = EMPTY_WRITE;
  for (const deal of delta.deals) {
    outcome = addWrites(outcome, await tx.saveDeal(deal));
  }
  for (const item of delta.tranches) {
    outcome = addWrites(outcome, await tx.saveTranche(item.snapshot, item.previous));
  }
  outcome = addWrites(outcome, await tx.appendJournal(delta.entries));
  for (const item of delta.payouts) {
    outcome = addWrites(outcome, await tx.savePayout(item.snapshot, item.previous));
  }
  return addWrites(outcome, await tx.appendAudit(delta.records));
}

async function commit(option: StoreOption, before: World | null, after: World): Promise<Written> {
  const delta = stepDelta(before, after);
  const store = storeOf(option);
  if (store === null) {
    // Мир без хранилища. Дельта всё равно построена: несохранимые части
    // называются одинаково в обоих режимах, и сценарий, идущий без базы, видит
    // ровно тот же список, что и сценарий с базой.
    return { world: after, outcome: EMPTY_WRITE, unmapped: delta.unmapped };
  }
  const outcome = await store.transact((tx) => writeDelta(tx, delta));
  return { world: after, outcome, unmapped: delta.unmapped };
}

/**
 * Первая запись: в базе нет ничего, мир кладётся целиком.
 *
 * Отдельно от `stepWorld` потому, что у первого мира нет предыдущего:
 * `emptyWorld` уже несёт запись открытия цепочки аудита, и шаг, сравнивающий
 * себя с предшественником, её бы не заметил.
 */
export function openWorld(store: StoreOption, world: World): Promise<Written> {
  return commit(store, null, world);
}

/**
 * Шаг мира вместе с записью.
 *
 * `run` выполняется **первым и целиком**: внутри него работают полномочие,
 * автомат, проекция намерений и `sealed`. Транзакция открывается только после
 * того, как шаг запечатан, — то есть база не видит ни одного намерения,
 * которое не прошло инварианты.
 *
 * Обратное — «открыть транзакцию, писать по ходу, в конце проверить» — выглядит
 * тем же самым и им не является: при таком порядке нарушение инварианта
 * обнаруживается после записи, и единственное, что отличает продукт от порчи
 * данных, — аккуратность `catch`. Здесь этого выбора нет: писать нечего, пока
 * шаг не запечатан.
 */
export async function stepWorld(
  store: StoreOption,
  before: World,
  run: (world: World) => World,
): Promise<Written> {
  return commit(store, before, run(before));
}

/**
 * То же для шагов, возвращающих не только мир (переход автомата, признание
 * недостачи, исход наблюдения). Результат отдаётся **после** записи, вместе с
 * ней: отказ базы забирает и его.
 *
 * ⚠ **Записывается только `World`.** Состояние, которое шаг держит рядом с
 * миром, а не в нём, дельта увидеть не может — и назвать потерянным тоже не
 * может, потому что не знает о его существовании. Сегодня такое состояние ровно
 * одно: `WithdrawalWorld` (`withdrawal.ts`) носит карту выводов сбоку от мира, и
 * у порта методов под них нет вовсе, хотя таблица `sdelka.withdrawal` в схеме
 * есть (`0005_payout.sql`). Значит вывод со счёта клиента через это подключение
 * в базу **не попадает и в списке непопавшего не появляется** — единственное
 * место, где здесь возможно молчание. Названо в отчёте; чинится либо методами
 * порта, либо переездом выводов в сам мир, и то и другое — за пределами этого
 * батча.
 */
export async function stepResult<T extends { readonly world: World }>(
  store: StoreOption,
  before: World,
  run: (world: World) => T,
): Promise<Written & { readonly result: T }> {
  const result = run(before);
  const written = await commit(store, before, result.world);
  return { ...written, result };
}

/* ------------------------------------------------------------------------- */
/* Подъём из хранилища                                                       */
/* ------------------------------------------------------------------------- */

export interface RestoredTranche {
  readonly snapshot: TrancheSnapshot;
  readonly payouts: readonly PayoutSnapshot[];
}

export interface RestoredDeal {
  readonly deal: DealSnapshot;
  readonly tranches: readonly RestoredTranche[];
}

/**
 * Мир, поднятый из хранилища.
 *
 * ⚠ Это **не** `World`, и подменять одно другим нельзя. `World` несёт факты
 * приложения — собранное, реквизиты, наблюдение, подписи, сессии, следы «кто
 * готовил», — а в схеме их нет: у порта нет ни колонок под них, ни методов.
 * Вернуть отсюда `World`, дозаполнив недостающее умолчаниями, значило бы
 * выдумать факты о деньгах: транш с `collectedAmount: null` и пустым списком
 * подписей — это не «тот же транш после перезапуска», а другой транш, которому
 * разрешено больше.
 *
 * Поэтому поднимается ровно то, что записано, а **чего не хватает — названо
 * списком** (`missing`). Круг «мир → база → мир» закрывается на журнале учёта,
 * цепочке аудита и автоматах; на фактах приложения он не закрыт, и это видно
 * значением, а не примечанием в отчёте.
 */
export interface RestoredWorld {
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly deals: readonly RestoredDeal[];
  readonly missing: readonly UnmappedPart[];
}

export interface RestoreRequest {
  readonly chainId: string;
  /**
   * Что поднимать. Идентификаторы приходится называть, потому что у порта нет
   * перечисления: `loadDeal(dealId)` и `loadTranche(dealId, trancheId)` — всё,
   * что есть. Для нового процесса, который поднимает мир целиком, этого мало;
   * пробел назван в `missing` каждого подъёма, а не только здесь.
   */
  readonly deals: readonly { readonly dealId: string; readonly trancheIds: readonly string[] }[];
}

export async function restoreWorld(
  store: WorldStore,
  request: RestoreRequest,
): Promise<RestoredWorld> {
  return store.transact(async (tx) => {
    const journal = await tx.readJournal();
    const chain = await tx.readChain(request.chainId);
    const deals: RestoredDeal[] = [];
    for (const wanted of request.deals) {
      const deal = await tx.loadDeal(wanted.dealId);
      if (deal === null) continue;
      const tranches: RestoredTranche[] = [];
      for (const trancheId of wanted.trancheIds) {
        const snapshot = await tx.loadTranche(wanted.dealId, trancheId);
        if (snapshot === null) continue;
        const payouts = await tx.loadPayouts(wanted.dealId, trancheId);
        tranches.push({ snapshot, payouts });
      }
      deals.push({ deal, tranches });
    }
    return Object.freeze({
      journal,
      chain,
      deals: Object.freeze(deals),
      /*
       * Список **структурный**, а не посчитанный по этому подъёму: перечислено
       * то, чего у хранилища нет вовсе, и оно одинаково при любом содержимом
       * базы. Считать его по данным значило бы отчитываться «в этот раз ничего
       * не потерялось» там, где потеряться нечему было по построению.
       */
      missing: Object.freeze([
        unmapped('deals', 'port.no_listing'),
        unmapped('tranche.facts', 'tranche.facts_not_storable'),
        unmapped('collected_not_backed', 'invariant.not_checkable'),
        unmapped('sessions', 'port.no_method'),
        unmapped('facts', 'port.no_method'),
        unmapped('tasks', 'port.no_method'),
      ]),
    });
  });
}

/**
 * Поверхность инвариантов у поднятого мира.
 *
 * Ровно то же значение, что даёт `surfaceOf(world)`: журнал, цепочка, состояния
 * траншей с их поручениями. Дальше его проверяет **та же** `surfaceViolations`,
 * что и мир в памяти, — и именно это делает утверждение «инварианты те же»
 * проверяемым, а не декларативным.
 *
 * Поручения берутся из снимков: `PayoutSnapshot.state` и есть `PayoutState`
 * домена, а не его проекция.
 */
export function surfaceOfRestored(restored: RestoredWorld): InvariantSurface {
  return {
    journal: restored.journal,
    chain: restored.chain,
    tranches: restored.deals.flatMap((deal) =>
      deal.tranches.map((item) => ({
        trancheId: item.snapshot.trancheId,
        state: item.snapshot.state,
        payouts: item.payouts.map((payout) => payout.state),
      })),
    ),
  };
}

/**
 * Инварианты поднятого мира.
 *
 * `claims` пуст — и это не «нарушений нет», а «эта проверка здесь невозможна»:
 * собранного в схеме нет. Разницу видно в `RestoredWorld.missing`, где
 * `collected_not_backed` назван непроверяемым. Молчаливого варианта у этого
 * различия быть не должно — ровно поэтому `surfaceViolations` требует список
 * притязаний аргументом.
 */
export function restoredViolations(restored: RestoredWorld): readonly InvariantViolation[] {
  return surfaceViolations(surfaceOfRestored(restored), []);
}
