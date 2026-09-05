import type { AuditChain, AuditRecord } from '@sdelka/audit';
import type {
  ConditionAct,
  DealState,
  PartyRef,
  PayoutState,
  TrancheState,
} from '@sdelka/domain';
import type { Journal, JournalEntry } from '@sdelka/ledger';
import type { CurrencyCode, Money } from '@sdelka/money';

/**
 * Порт хранилища мира — по образцу `packages/app/src/ports.ts`: интерфейс над
 * доменными значениями, реализация подставляется снаружи.
 *
 * **Зачем он появился.** У `packages/db` не было ни одного потребителя: поиск
 * `@sdelka/db` вне самого пакета не давал ни одного попадания, включая
 * `package.json`. Девятнадцать миграций, полсотни ограничений, триггеры, гранты
 * и 161 интеграционный тест сторожили схему, которую в рантайме не наполнял
 * никто, а мир приложения (`app/src/world.ts`) жил в памяти и умирал вместе с
 * процессом. Тест, проверяющий то, чем никто не пользуется, зелёный по
 * построению — тот же дефект, из-за которого в своё время появился сам
 * `packages/app` (см. его `index.ts`).
 *
 * ⚠ **Почему порт объявлен здесь, а не в `packages/app` рядом с остальными
 * портами.** Реестр, банк и скрининг объявлены в приложении потому, что их
 * значения — доменные значения приложения (`ReleaseObservation`,
 * `ReconciliationOutcome`), и никакой другой пакет их не знает. У хранилища
 * словарь другой: `Journal`, `JournalEntry`, `TrancheState`, `PayoutState`,
 * `AuditChain` — всё это живёт в `@sdelka/ledger`, `@sdelka/domain` и
 * `@sdelka/audit`, то есть в пакетах, которые **обе** стороны границы и так
 * знают. Ни одного типа из `@sdelka/app` в этом файле нет.
 *
 * Объявить порт в приложении означало бы завести ребро `@sdelka/db →
 * @sdelka/app`. Цикла оно не даёт (`packages/app` на `packages/db` не
 * ссылается и ссылаться не должен), но переворачивает слои: зависимости `db` —
 * строгое подмножество зависимостей `app`, и такое ребро затащило бы
 * `@sdelka/compliance` и `@sdelka/oracle` в граф сборки команды `pnpm
 * db:migrate`, которой они не нужны ни одной строкой. Поэтому порт объявлен
 * над общим словарём, в отдельном модуле, который не знает ни `pg`, ни SQL, ни
 * пула, — и это проверяется тестом (`test/store-port.test.ts`), а не обещанием
 * в комментарии.
 *
 * Когда шагу мира понадобится писать самому, тип, который он примет
 * аргументом, обязан быть объявлен над тем же общим словарём; вынести его
 * тогда в отдельный пакет — решение владельца, а не наше. Помечено
 * **[открыто]**.
 *
 * **Чего в порту нет и почему.** Нет метода «сохранить мир целиком». `World`
 * запечатан меткой происхождения (`worldBrand`), и функция, принимающая мир
 * снаружи и возвращающая мир, была бы дверью мимо `sealed`: любой вызывающий
 * собрал бы мир с нужной ему сессией и нужным ему «кто готовил». Хранилище
 * поэтому работает не с миром, а со **снимками** его частей — журнал, цепочка,
 * сделка, транш, выплата, — и обратно отдаёт их же. Собирать из них мир — дело
 * шагов `flow.ts`, у которых есть `Authority`.
 */

/* ------------------------------------------------------------------------- */
/* Исход записи                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Что случилось с записью: сколько строк появилось и сколько уже лежало **тем
 * же самым**.
 *
 * Два числа, а не `void`, и это и есть договор об идемпотентности. Повтор шага
 * обязан быть отличим от первой записи — иначе «повторили и ничего не
 * заметили» неотличимо от «записали дважды». Третьего исхода нет: строка,
 * лежащая под тем же ключом, но с другим содержимым, — не повтор, а конфликт,
 * и она поднимает ошибку, а не увеличивает счётчик.
 */
export interface WriteOutcome {
  /** Сколько строк появилось в базе этим вызовом. */
  readonly written: number;
  /** Сколько строк уже лежало и совпало содержимым до последнего поля. */
  readonly repeated: number;
}

export const EMPTY_WRITE: WriteOutcome = Object.freeze({ written: 0, repeated: 0 });

export function addWrites(left: WriteOutcome, right: WriteOutcome): WriteOutcome {
  return Object.freeze({
    written: left.written + right.written,
    repeated: left.repeated + right.repeated,
  });
}

/* ------------------------------------------------------------------------- */
/* Снимки                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Сделка: состояние и обе стороны.
 *
 * Стороны обязательны, потому что они обязательны у сделки: `PartyRef` несёт
 * обе половины личности сразу (`FUNCTIONAL.md` §2.1), и хранилище, принимающее
 * половину, вернуло бы сделку, у которой деньги и профиль принадлежат разным
 * лицам.
 */
export interface DealSnapshot {
  readonly dealId: string;
  readonly state: DealState;
  readonly buyer: PartyRef;
  readonly seller: PartyRef;
}

/**
 * Транш: состояние вместе с актом получателя и требуемой суммой.
 *
 * Акт не отдельным полем, а **внутри состояния** (`TrancheState.conditionAct`):
 * состояние после `pending` без акта собрать нельзя (`assertConditionAct`,
 * `CORE.md` Ф13), и хранилище не имеет права уметь то, чего не умеет домен.
 *
 * Требуемая сумма — единственный денежный факт транша, который держит домен
 * (`TrancheFacts.requiredAmount`). Собранное, запертое и покрытие считаются из
 * журнала на каждый вызов и в снимке не хранятся: два ответа на один денежный
 * вопрос расходятся молча.
 */
export interface TrancheSnapshot {
  readonly dealId: string;
  readonly trancheId: string;
  readonly state: TrancheState;
  /** `null` — сумма ещё не назначена. */
  readonly required: Money<CurrencyCode> | null;
}

/**
 * Поручение: состояние домена плюс то, без чего поручение не существует как
 * операция.
 *
 * `evidenceBundleId` обязателен по типу — красная линия №5: «выплата невозможна
 * без ссылки на пакет доказательств; кнопки „просто выплатить“ не существует».
 * Необязательное поле здесь и было бы такой кнопкой.
 */
export interface PayoutSnapshot {
  readonly payoutId: string;
  readonly dealId: string;
  readonly state: PayoutState;
  readonly amount: Money<CurrencyCode>;
  /** Кому уходит перевод. Сторона целиком, а не её половина. */
  readonly beneficiary: PartyRef;
  readonly evidenceBundleId: string;
  /**
   * Ссылка на ответ провайдера. `null` — ответа ещё нет, и это законное
   * состояние (`STATE-MACHINES.md` §2.2, красная линия №8).
   */
  readonly providerReference: string | null;
}

/* ------------------------------------------------------------------------- */
/* Порт                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Один шаг мира — одна транзакция.
 *
 * Шаг меняет журнал учёта, состояние и журнал аудита **вместе**: запись о
 * решении без проводки, которую она объясняет, — это журнал, который врёт, а
 * проводка без записи о решении — деньги без основания. Поэтому у порта нет
 * отдельных «сохранить журнал» и «сохранить транш» на верхнем уровне: всё, что
 * относится к шагу, происходит внутри `transact`, и либо ложится целиком, либо
 * не ложится вовсе.
 */
export interface WorldStore {
  transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T>;
}

export interface WorldTransaction {
  /**
   * Дописать записи журнала учёта.
   *
   * Журнал только дополняется (красная линия №11), поэтому метода «изменить
   * запись» здесь нет и быть не может — ровно так же, как его нет в
   * `@sdelka/ledger`.
   */
  appendJournal(entries: readonly JournalEntry[]): Promise<WriteOutcome>;

  /**
   * Прочитать журнал обратно.
   *
   * Договор чтения: `checkLedgerInvariants` на прочитанном журнале обязан дать
   * то же, что на исходном. Это и есть смысл круга «мир → база → мир»: если
   * инварианты на прочитанном расходятся с инвариантами на записанном, значит
   * хранилище — не хранилище, а фильтр.
   */
  readJournal(): Promise<Journal>;

  /**
   * Дописать записи журнала аудита. Цепочка сохраняется: нумерацию и сцепку по
   * хешу проверяет база при вставке, значение хеша — код при чтении.
   */
  appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome>;

  /** Прочитать цепочку. Целостность прочитанного проверяется на месте. */
  readChain(chainId: string): Promise<AuditChain>;

  saveDeal(snapshot: DealSnapshot): Promise<WriteOutcome>;
  loadDeal(dealId: string): Promise<DealSnapshot | null>;

  /**
   * Сохранить транш.
   *
   * `previous` — состояние, из которого шаг делается. `null` означает «транша
   * ещё нет». Это не удобство: у схемы нет колонки версии, поэтому единственный
   * строгий способ не затереть чужой шаг — сверить, что в базе лежит ровно то,
   * из чего мы уходим. Несовпадение — конфликт с именем, а не молчаливая
   * перезапись.
   */
  saveTranche(snapshot: TrancheSnapshot, previous: TrancheSnapshot | null): Promise<WriteOutcome>;
  loadTranche(dealId: string, trancheId: string): Promise<TrancheSnapshot | null>;

  /** То же правило сверки, что у транша: шаг объявляет, из чего уходит. */
  savePayout(snapshot: PayoutSnapshot, previous: PayoutSnapshot | null): Promise<WriteOutcome>;
  loadPayouts(dealId: string, trancheId: string): Promise<readonly PayoutSnapshot[]>;
}

/* ------------------------------------------------------------------------- */
/* Сравнение снимков                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Равенство снимков — **над доменными значениями, а не над строками таблицы**.
 *
 * Идемпотентность повторной записи держится на сравнении «то, что лежит» с
 * «тем, что пишем». Сравнение колонок проверяло бы равенство собственной
 * проекции, и поле, которое проекция теряет, всегда равнялось бы само себе.
 * Сравнение доменных значений такой поблажки не даёт.
 */
export function conditionActsSame(left: ConditionAct | null, right: ConditionAct | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.recipient.partyId === right.recipient.partyId &&
    left.recipient.accountKey === right.recipient.accountKey &&
    left.agreedAt === right.agreedAt &&
    left.conditionTextVersion === right.conditionTextVersion &&
    left.conditionType === right.conditionType
  );
}

function moneySame(left: Money<CurrencyCode> | null, right: Money<CurrencyCode> | null): boolean {
  if (left === null || right === null) return left === right;
  return left.currency === right.currency && left.minor === right.minor;
}

export function trancheStatesSame(left: TrancheState, right: TrancheState): boolean {
  if (left.status !== right.status) return false;
  // Разбор по форме союза, а не по перечню полей: у терминального варианта
  // полей нет вовсе, у замороженного нет дедлайна, и «сравнить всё, что есть»
  // на разных вариантах сравнило бы разное.
  if (!('enteredAt' in left) || !('enteredAt' in right)) {
    return !('enteredAt' in left) && !('enteredAt' in right);
  }
  if (left.enteredAt !== right.enteredAt) return false;
  if (!conditionActsSame(left.conditionAct, right.conditionAct)) return false;
  if ('deadline' in left || 'deadline' in right) {
    return 'deadline' in left && 'deadline' in right && left.deadline.at === right.deadline.at;
  }
  if (left.status !== 'frozen' || right.status !== 'frozen') return false;
  return (
    left.suspendedFrom === right.suspendedFrom &&
    left.remaining === right.remaining &&
    left.reason === right.reason &&
    left.frozenBy === right.frozenBy
  );
}

export function trancheSnapshotsSame(left: TrancheSnapshot, right: TrancheSnapshot): boolean {
  return (
    left.dealId === right.dealId &&
    left.trancheId === right.trancheId &&
    moneySame(left.required, right.required) &&
    trancheStatesSame(left.state, right.state)
  );
}

export function dealSnapshotsSame(left: DealSnapshot, right: DealSnapshot): boolean {
  return (
    left.dealId === right.dealId &&
    left.state.status === right.state.status &&
    left.buyer.partyId === right.buyer.partyId &&
    left.buyer.accountKey === right.buyer.accountKey &&
    left.seller.partyId === right.seller.partyId &&
    left.seller.accountKey === right.seller.accountKey
  );
}

export function payoutSnapshotsSame(left: PayoutSnapshot, right: PayoutSnapshot): boolean {
  return (
    left.payoutId === right.payoutId &&
    left.dealId === right.dealId &&
    left.state.status === right.state.status &&
    left.state.idempotencyKey === right.state.idempotencyKey &&
    left.state.trancheId === right.state.trancheId &&
    left.state.leg === right.state.leg &&
    moneySame(left.amount, right.amount) &&
    left.beneficiary.partyId === right.beneficiary.partyId &&
    left.beneficiary.accountKey === right.beneficiary.accountKey &&
    left.evidenceBundleId === right.evidenceBundleId &&
    left.providerReference === right.providerReference
  );
}
