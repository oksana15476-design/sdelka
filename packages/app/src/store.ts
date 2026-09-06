import type { AuditChain, AuditRecord } from '@sdelka/audit';
import {
  type DealState,
  type PartyRef,
  type PayoutLeg,
  type PayoutState,
  type TrancheState,
  type WithdrawalState,
  boundConditionAct,
} from '@sdelka/domain';
import { type Journal, type JournalEntry, appendEntry, emptyJournal } from '@sdelka/ledger';
import { type CurrencyCode, type Money, split } from '@sdelka/money';
import { journalEntryIdPrefix, seqOfEternalId } from './ids';
import {
  type DealRuntime,
  type InvariantSurface,
  type InvariantViolation,
  type TrancheRuntime,
  type WithdrawalRuntime,
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

/**
 * Вывод со счёта клиента — зеркало `WithdrawalSnapshot` из `@sdelka/db`.
 *
 * ⚠ Зеркало сверяется присваиванием **в обе стороны**
 * (`packages/e2e/test/store-port.test.ts`): разошедшиеся объявления роняют типы,
 * а не расходятся молча. Пока этого снимка здесь не было, вывод не писался
 * вовсе и в перечне непопавшего не появлялся — единственное место во всём
 * подключении, где возможно было молчание.
 *
 * Своего номера у снимка нет: он уже лежит в `WithdrawalState`. Отпечаток
 * счёта-источника вместо самих реквизитов — номер счёта в открытом виде в базе
 * не живёт (красная линия №9).
 */
export interface WithdrawalSnapshot {
  readonly state: WithdrawalState;
  readonly party: PartyRef;
  readonly amount: Money<CurrencyCode>;
  readonly sourceAccountFingerprint: string;
}

/**
 * Охват чтения журнала — **обязательный аргумент**, а не удобство.
 *
 * Журнал учёта в базе один и общий: в нём лежат записи всех миров сразу.
 * `readJournal()` без охвата отдавал их скопом, и подъём мира сравнивал своё
 * состояние с чужими проводками — то есть красная линия №1 («средства одной
 * сделки не финансируют обязательство по другой») держалась тем, что в базе жил
 * ровно один мир. Аргумент делает вопрос обязательным: «весь журнал без
 * разбора» стало не пропуском параметра, а **написанным словом**
 * (`entireJournal`, с названной причиной) — тот же приём, что у `WITHOUT_STORE`.
 *
 * Отбор идёт по началу идентификатора (`ids.ts`, `journalEntryIdPrefix`) и
 * потому **грубый**: хранилище отдаёт надмножество, а точное правило —
 * `seqOfEternalId` — применяет `restoreWorld`. Форма идентификатора хранилищу не
 * известна и известна быть не должна: она свойство того модуля, который её
 * чеканит.
 */
export type JournalScope =
  | {
      readonly kind: 'chain';
      /** Начало идентификатора: `${chainId}:e`. Собирается `chainScope`. */
      readonly entryIdPrefix: string;
    }
  | {
      readonly kind: 'everything';
      /** Зачем читается весь журнал. Ключ, а не текст: три языка (`CLAUDE.md`). */
      readonly reasonKey: string;
    };

/** Охват одного мира: записи его цепочки. */
export function chainScope(chainId: string): JournalScope {
  return Object.freeze({ kind: 'chain' as const, entryIdPrefix: journalEntryIdPrefix(chainId) });
}

/**
 * Весь журнал без разбора — сверка, отчётность, надзор.
 *
 * Причина обязательна и приезжает ключом: чтение, охватывающее чужие миры,
 * обязано быть названо в том месте, где оно написано, а не выясняться потом по
 * следам. Случайно сюда не попасть — попасть можно только вызовом.
 */
export function entireJournal(reasonKey: string): JournalScope {
  return Object.freeze({ kind: 'everything' as const, reasonKey });
}

export interface WorldStore {
  transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T>;
}

export interface WorldTransaction {
  appendJournal(entries: readonly JournalEntry[]): Promise<WriteOutcome>;
  readJournal(scope: JournalScope): Promise<Journal>;
  appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome>;
  readChain(chainId: string): Promise<AuditChain>;
  saveDeal(snapshot: DealSnapshot): Promise<WriteOutcome>;
  loadDeal(dealId: string): Promise<DealSnapshot | null>;
  saveTranche(snapshot: TrancheSnapshot, previous: TrancheSnapshot | null): Promise<WriteOutcome>;
  loadTranche(dealId: string, trancheId: string): Promise<TrancheSnapshot | null>;
  savePayout(snapshot: PayoutSnapshot, previous: PayoutSnapshot | null): Promise<WriteOutcome>;
  loadPayouts(dealId: string, trancheId: string): Promise<readonly PayoutSnapshot[]>;
  saveWithdrawal(
    snapshot: WithdrawalSnapshot,
    previous: WithdrawalSnapshot | null,
  ): Promise<WriteOutcome>;
  /**
   * Списком по стороне, а не по одному номеру: правило `g_no_active_withdrawal`
   * считает незавершённые выводы по счёту клиента, и чтение по номеру ответа на
   * этот вопрос не даёт — номера после перезапуска взять неоткуда.
   */
  loadWithdrawals(partyId: string): Promise<readonly WithdrawalSnapshot[]>;
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
   * Изменились факты заявки, а не её состояние: подписи, готовивший, лицо,
   * вызвавшее удержание, след поднятой дежурному задачи. Колонок под них нет —
   * `sdelka.withdrawal` держит состояние, сторону, сумму, отпечаток и часы.
   */
  'withdrawal.facts_not_storable',
  /**
   * Счёт-источник заявки неизвестен, а `source_account_fingerprint NOT NULL` —
   * красная линия №9 в схеме. Заявка с неизвестным источником в базу не ложится
   * вовсе: подставить сюда отпечаток означало бы назвать счёт, которого никто
   * не называл. Машина в этом случае уводит заявку в `blocked`
   * (`g_source_account_known`), и дальше её ведёт человек.
   *
   * ⚠ Следствие того же порядка, что у возвратного поручения: пока строки нет,
   * частичный уникальный индекс `withdrawal_one_active_per_party` эту заявку не
   * сторожит — сторожить нечего.
   */
  'withdrawal.source_account_unknown',
  /**
   * Красная линия №5 в схеме: `payout.evidence_bundle_id NOT NULL`. У возврата
   * покупателю пакета доказательств нет и быть не обязано — возвращаются
   * собственные деньги плательщика (`flow.ts`, `enqueue_outbound_refund`).
   * Поручение на возврат в базу поэтому не ложится вовсе.
   */
  'payout.evidence_bundle_missing',
  /** Получателя расчёта называет акт об условии; без акта поручение не описать. */
  'payout.beneficiary_unknown',
  /**
   * Тарифа у транша нет (поднятый мир, `resume.ts`), а расчётное поручение
   * несёт **нетто** — сумму за вычетом комиссии. Без тарифа она не «равна
   * собранной», она неизвестна, и снимок не собирается вовсе.
   */
  'payout.tariff_unknown',
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
function payoutAmountOf(runtime: TrancheRuntime, leg: PayoutLeg): Money<CurrencyCode> | null {
  const gross = runtime.facts.collectedAmount ?? runtime.facts.requiredAmount;
  if (leg === 'refund') return gross;
  /*
   * Удержание — из тарифа транша, и другого его источника нет. У транша,
   * поднятого из хранилища, тарифа нет вовсе (`resume.ts`), и прежде это
   * читалось как пустой список удержаний, то есть **как нулевая комиссия**:
   * поручение уходило на всю собранную сумму. Теперь это `null` — снимка не
   * будет, причина названа, и молча переплатить получателю нечем.
   */
  const tariff = runtime.tariff;
  if (tariff === null) return null;
  return split(gross, tariff.deductions).recipient;
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
    const amount = payoutAmountOf(runtime, state.leg);
    if (amount === null) {
      // Расчётное поручение без тарифа: сумма к выплате неизвестна, а не «вся
      // собранная». Красная линия №2 держится и здесь — комиссия не может
      // потеряться по дороге в снимок.
      return missing<PayoutSnapshot>(`payout:${payoutId}`, 'payout.tariff_unknown');
    }
    return mapped({
      payoutId,
      dealId: runtime.dealId,
      state,
      amount,
      beneficiary,
      evidenceBundleId,
      providerReference: providerReferenceOf(chain, state, ordinal),
    });
  });
}

/**
 * Снимок заявки на вывод.
 *
 * Номер, сторона, сумма, отпечаток счёта-источника и часы — всё, что держит
 * `sdelka.withdrawal`. Ничего сверх этого сюда не попадает и попасть не может:
 * `holderIsPayer` — факт момента утверждения, а не свойство строки (см.
 * `WithdrawalSnapshot` в `packages/db/src/store/port.ts`), подписи и готовивший
 * колонок не имеют.
 *
 * Единственный случай, когда снимка нет: счёт-источник неизвестен. Он назван
 * причиной, а не обойдён подстановкой, — отпечаток из нулей был бы синтаксически
 * годной строкой и ложью по существу.
 */
export function withdrawalSnapshotOf(runtime: WithdrawalRuntime): Mapping<WithdrawalSnapshot> {
  const source = runtime.sourceAccount;
  if (source === null) {
    return missing<WithdrawalSnapshot>(
      `withdrawal:${runtime.state.withdrawalId}`,
      'withdrawal.source_account_unknown',
    );
  }
  return mapped({
    state: runtime.state,
    party: runtime.party,
    amount: runtime.amount,
    sourceAccountFingerprint: source.accountRef,
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

export interface WithdrawalWrite {
  readonly snapshot: WithdrawalSnapshot;
  /** Состояние, из которого шаг делается. `null` — заявки в базе ещё нет. */
  readonly previous: WithdrawalSnapshot | null;
}

export interface WorldDelta {
  readonly entries: readonly JournalEntry[];
  readonly records: readonly AuditRecord[];
  readonly deals: readonly DealSnapshot[];
  readonly tranches: readonly TrancheWrite[];
  readonly payouts: readonly PayoutWrite[];
  readonly withdrawals: readonly WithdrawalWrite[];
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

  /*
   * Заявки на вывод — тем же сравнением двух миров, что и транши.
   *
   * Отдельного «сохранить заявку» мимо шага здесь нет и быть не должно: заявка
   * меняется только внутри `sealed`, а сюда приезжает уже разницей двух
   * проверенных миров. Прежде она не приезжала вовсе — карта выводов лежала
   * сбоку от `World`, и записать её было **нечем**, а назвать потерянной —
   * некому.
   */
  const withdrawals: WithdrawalWrite[] = [];
  for (const [withdrawalId, runtime] of after.withdrawals) {
    const previousRuntime = before === null ? null : (before.withdrawals.get(withdrawalId) ?? null);
    if (previousRuntime === runtime) continue;
    const snapshot = withdrawalSnapshotOf(runtime);
    if (snapshot.kind === 'unmapped') {
      parts.push(snapshot.part);
      continue;
    }
    /*
     * «Из чего уходим» — по **предыдущему** миру, как у сделки и транша. Если
     * прежнее состояние в базу не легло (счёт-источник был неизвестен), то
     * уходить не из чего: в базе строки нет, и шаг обязан заявить вставку, а не
     * обновление. Ошибиться здесь безопасно ровно в одну сторону — хранилище
     * ответит конфликтом с именем, а не перезапишет чужое.
     */
    const earlier = previousRuntime === null ? null : withdrawalSnapshotOf(previousRuntime);
    const previous = earlier !== null && earlier.kind === 'mapped' ? earlier.value : null;
    if (previous !== null && sameSnapshot(previous, snapshot.value)) {
      // Автомат стоит на месте, а заявка изменилась: изменились факты
      // приложения — подписи, лицо, вызвавшее удержание, след поднятой задачи.
      parts.push(unmapped(`withdrawal:${withdrawalId}`, 'withdrawal.facts_not_storable'));
      continue;
    }
    withdrawals.push({ snapshot: snapshot.value, previous });
  }

  for (const part of worldOnlyParts(before, after)) parts.push(part);

  return Object.freeze({
    entries,
    records,
    deals: Object.freeze(deals),
    tranches: Object.freeze(tranches),
    payouts: Object.freeze(payouts),
    withdrawals: Object.freeze(withdrawals),
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
  /*
   * Остановка приёма новых сделок (красная линия №3). Не перечень и не карта —
   * одно значение, поэтому сравнивается тождеством, а не размером: остановка
   * поставлена, снята или сменила заявку на снятие — в базу не легло ничего.
   * Колонки под неё в схеме нет, и подъём это знает (`resume.ts`, `GAPS`):
   * поднятый мир начинается с остановленным приёмом.
   */
  const haltBefore = before === null ? null : before.halt;
  if ((before === null ? after.halt !== null : haltBefore !== after.halt)) {
    out.push(unmapped('intake_halt', 'port.no_method'));
  }
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
  /*
   * Заявка на вывод — после проводок, вместе с поручениями и по той же причине:
   * сначала деньги, потом распоряжение о них. Сделки у неё нет вовсе, ссылается
   * она только на сторону, и сторону кладёт сама (`saveWithdrawal`).
   *
   * Здесь же в шаг приезжает правило «одна незавершённая заявка на сторону»:
   * его держит частичный уникальный индекс базы, и восьмой проверки в коде у
   * него нет намеренно. Отказ индекса переводится в ошибку домена с именем
   * guard'а (`db/src/store/errors.ts`), то есть шаг останавливается так же, как
   * останавливает его сам автомат, — и нового мира у вызывающего не остаётся.
   */
  for (const item of delta.withdrawals) {
    outcome = addWrites(outcome, await tx.saveWithdrawal(item.snapshot, item.previous));
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
 * может, потому что не знает о его существовании.
 *
 * Такое состояние было ровно одно — карта выводов в `WithdrawalWorld`, — и
 * именно поэтому заявка на вывод в базу не попадала и в списке непопавшего не
 * появлялась. Оно переехало **в мир** (`world.ts`, `World.withdrawals`), и
 * молчания больше нет: заявка приезжает в дельту разницей двух миров, как
 * транш. Сбоку осталось то, что состоянием не является, — часы заявки
 * (`WithdrawalWorld.clock`, версия настройки владельца).
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
  /**
   * Журнал **своей цепочки**, а не журнал базы: охват задан чтением
   * (`JournalScope`) и уточнён разбором идентификаторов (`journalOfChain`).
   * Прежде здесь лежали проводки всех миров сразу, и «покрытие клиентских
   * средств» у поднятого мира считалось по чужим деньгам.
   */
  readonly journal: Journal;
  readonly chain: AuditChain;
  readonly deals: readonly RestoredDeal[];
  /**
   * Заявки на вывод названных сторон — снимками, а не заявками.
   *
   * Часы у них подняты (`0022`: `deadline_at`, `entered_at`), а всё остальное,
   * чем заявка живёт в мире, — нет: ни готовившего, ни подписей, ни того, кто
   * увёл её в удержание, ни следа поднятой дежурному задачи, ни половины
   * счёта-источника `holderIsPayer`. Что именно недостаёт и чем это отзывается,
   * названо в `resume.ts` (`GAPS`) — там, где из снимка собирается заявка.
   */
  readonly withdrawals: readonly WithdrawalSnapshot[];
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
  /**
   * Чьи заявки на вывод поднимать — идентификаторы сторон.
   *
   * Поле **обязательное**, и пустой список — это написанное «ничьих», а не
   * забытый аргумент. Тот же приём, что у охвата чтения журнала, и по той же
   * причине: заявка, не поднятая молча, — это заявка, о существовании которой
   * поднятый мир не знает, притом что деньги по ней уже могут быть в полёте.
   *
   * Из сделок стороны **не выводятся**: клиент, у которого на счету остаток от
   * прошлой сделки, к поднимаемым сделкам может не иметь отношения вовсе, а
   * заявка у него быть может. Догадка здесь молча теряла бы ровно те заявки,
   * ради которых поле заведено.
   */
  readonly parties: readonly string[];
}

/**
 * Журнал одной цепочки из журнала, отобранного грубо.
 *
 * Хранилище отбирает по началу идентификатора и потому может отдать лишнее
 * (`ids.ts`, `journalEntryIdPrefix`); здесь отбор идёт **разбором** — тем же
 * модулем, который идентификаторы чеканит. Журнал пересобирается `appendEntry`,
 * а не режется массивом: правила учёта, которым нужна история (зеркальность
 * исправления, «расчёт отматывается один раз», ключ конверсии), обязаны пройти
 * по той истории, которую поднятый мир и получит.
 */
function journalOfChain(journal: Journal, chainId: string): Journal {
  const mine = journal.entries.filter((entry) => seqOfEternalId(chainId, entry.id) !== null);
  if (mine.length === journal.entries.length) return journal;
  let out = emptyJournal;
  for (const entry of mine) out = appendEntry(out, entry);
  return out;
}

export async function restoreWorld(
  store: WorldStore,
  request: RestoreRequest,
): Promise<RestoredWorld> {
  return store.transact(async (tx) => {
    /*
     * Охват — своя цепочка, и он обязателен (см. `JournalScope`). До него
     * поднятый журнал нёс проводки **всех** миров базы: инварианты покрытия
     * считались по чужим деньгам, а сравнение с миром в памяти шло по отбору,
     * который делал каждый вызывающий сам.
     */
    const read = await tx.readJournal(chainScope(request.chainId));
    const journal = journalOfChain(read, request.chainId);
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
    /*
     * Заявки — по стороне, а не по номеру: `g_no_active_withdrawal` считает
     * незавершённые выводы по счёту клиента, а номера после перезапуска взять
     * неоткуда. Порядок между сторонами сохраняется как назван: он и есть весь
     * охват, другого у порта нет.
     */
    const withdrawals: WithdrawalSnapshot[] = [];
    for (const partyId of request.parties) {
      for (const snapshot of await tx.loadWithdrawals(partyId)) withdrawals.push(snapshot);
    }
    return Object.freeze({
      journal,
      chain,
      deals: Object.freeze(deals),
      withdrawals: Object.freeze(withdrawals),
      /*
       * Список **структурный**, а не посчитанный по этому подъёму: перечислено
       * то, чего у хранилища нет вовсе, и оно одинаково при любом содержимом
       * базы. Считать его по данным значило бы отчитываться «в этот раз ничего
       * не потерялось» там, где потеряться нечему было по построению.
       */
      missing: Object.freeze([
        unmapped('deals', 'port.no_listing'),
        /*
         * Перечисления заявок у порта нет тоже: поднимаются выводы **названных**
         * сторон, и «все выводы базы» неспрашиваемы. Строка стоит здесь всегда,
         * а не только когда список сторон пуст: перечня нет по построению, и
         * отчитываться «в этот раз ничего не потерялось» было бы неправдой.
         */
        unmapped('withdrawals', 'port.no_listing'),
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
