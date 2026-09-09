import type { AuditChain, AuditRecord } from '@sdelka/audit';
import type {
  ConditionAct,
  DealState,
  PartyRef,
  PayoutState,
  TrancheState,
  WithdrawalState,
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

/**
 * Вывод со счёта клиента — ROADMAP.md И12.2, `domain/src/client-account.ts`.
 *
 * **Почему снимок понадобился отдельно.** Сделка, транш и поручение через порт
 * ложились, вывод — нет: таблица (`0005_payout.sql`) и машина из шести
 * состояний были, методов не было. Всё, что не легло, порт называет значением
 * (`WriteOutcome`) либо отказом с ключом; вывод не возвращал ничего — и это
 * было единственное место во всём подключении, где возможно было молчание.
 *
 * Своего `withdrawalId` у снимка нет: он уже лежит в `WithdrawalState`
 * (`createWithdrawal`), и второе поле с тем же смыслом разошлось бы с первым
 * молча. У поручения иначе — `PayoutState` номера поручения не несёт вовсе.
 *
 * **Чего в снимке нет и почему.**
 *
 * - `holderIsPayer` (`SourceAccountRef`): колонки под него в схеме нет, и это
 *   не пропуск. Это **факт момента утверждения**, вход guard'а
 *   `g_source_account_known`, ровно как собранное, подписи и покрытие у транша
 *   — их порт тоже не хранит. Записать его сюда пришлось бы значением, а
 *   вернуть — выдуманным: хранилище, отдающее «владелец совпал с плательщиком»
 *   по умолчанию, врёт про красную линию №9 в ту сторону, которая стоит денег.
 * - ссылки на ответ провайдера: исходящая нога вывода не переизобретается, её
 *   ведёт машина «Выплата» со своим `unknown` (`client-account.ts`, §2.2).
 */
export interface WithdrawalSnapshot {
  readonly state: WithdrawalState;
  /** Клиент, со счёта которого идёт вывод. Сторона целиком, а не её половина. */
  readonly party: PartyRef;
  readonly amount: Money<CurrencyCode>;
  /**
   * Отпечаток счёта-источника, а не сами реквизиты: номер счёта в открытом виде
   * в базе не живёт (красная линия №9 плюс `compliance/src/pii.ts`). Отпечаток
   * считает вызывающий — здесь он непрозрачная строка, и порт над общим
   * словарём другого выбора не имеет.
   */
  readonly sourceAccountFingerprint: string;
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
/**
 * Охват чтения журнала — **зеркало `packages/app/src/store.ts`**, как и снимки
 * выше, и сверяется оно присваиванием в обе стороны
 * (`packages/e2e/test/store-port.test.ts`).
 *
 * Журнал учёта в базе один и общий, а миров в нём много. Чтение без охвата
 * отдавало записи всех сразу: подъём мира считал покрытие по чужим деньгам, а
 * отбор «своих» строк делал каждый вызывающий сам и по-своему. Здесь охват —
 * аргумент, то есть вопрос, на который обязан ответить тот, кто читает.
 *
 * Отбор идёт по **началу идентификатора**. Форма идентификатора хранилищу не
 * известна и известна быть не должна: её знает тот модуль слоя приложения,
 * который её чеканит (`app/src/ids.ts`), и он же собирает эту величину. Отбор
 * поэтому грубый — надмножество, — а точное правило применяет вызывающий.
 */
export type JournalScope =
  | { readonly kind: 'chain'; readonly entryIdPrefix: string }
  | { readonly kind: 'everything'; readonly reasonKey: string };

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
   * Прочитать журнал обратно **в названном охвате**.
   *
   * Договор чтения: `checkLedgerInvariants` на прочитанном журнале обязан дать
   * то же, что на исходном. Это и есть смысл круга «мир → база → мир»: если
   * инварианты на прочитанном расходятся с инвариантами на записанном, значит
   * хранилище — не хранилище, а фильтр.
   *
   * Охват обязателен по той же причине, по которой обязателен `previous` у
   * записи состояния: таблица одна, а миров в ней много, и «весь журнал»
   * обязано быть написанным решением, а не пропущенным аргументом.
   */
  readJournal(scope: JournalScope): Promise<Journal>;

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
   * Сделки, где названная сторона — **сторона**: и те, где она покупатель, и
   * те, где продавец.
   *
   * **Зачем.** `loadDeal(dealId)` требует знать номер заранее, а у вошедшего его
   * взять неоткуда: экран знает, **кто** вошёл, и не знает, **что** у него есть
   * (`ROAD-TO-SCREEN.md` §4.1). Пробел у порта был назван поимённо
   * (`app/src/store.ts`, `port.no_listing`) — это он.
   *
   * **Почему сторона — аргумент, а не фильтр вызывающего.** Метода «все сделки»
   * здесь нет намеренно. Чтение всего с отбором в коде означает, что чужая
   * сделка **уже приехала** в процесс, и от перечисления чужого её отделяет один
   * не забытый `filter`. Здесь вопрос «чьи» обязателен, а отбор идёт в базе:
   * то, чего не выбрали, наружу не выходит вовсе (спека §3.2, правило 2:
   * «перечислять чужие сделки и чужие учётные записи нельзя»).
   *
   * Ключ — `partyId`, тот же, что у `loadWithdrawals`: половина `PartyRef`,
   * которой сделка названа в снимке. Ключ счёта сюда не годится — он форма того
   * же лица в плане счетов, и спрашивать одно и то же двумя ключами значило бы
   * завести два ответа на один вопрос.
   *
   * **Порядок — часть договора, а не как ляжет.** Без `ORDER BY` порядок строк
   * решает планировщик, и список, прочитанный дважды, приходит в разном
   * порядке: кабинет «прыгает» между переходами, а тест на нём либо зелёный
   * случайно, либо красный случайно. Порядок здесь — **от свежих к старым по
   * моменту заведения, при совпадении момента — по идентификатору**: кабинет
   * читают сверху вниз, и сверху обязано быть последнее заведённое. Момент
   * заведения держит хранилище (строка сделки), а не снимок: класть его в
   * `DealSnapshot` значило бы завести поле в путь записи и в сравнение снимков
   * ради одного лишь отображения. Когда кабинету понадобится **показать** дату
   * заведения, поле придётся завести — **[открыто]**, решение владельца.
   *
   * **Мир не поднимается.** Это чтение снимков, а не `resumeWorld`: список
   * сделок — вопрос отображения, а восстановление мира стоит журнала, цепочки и
   * проверки инвариантов на каждую строку списка (спека §3.2, правило 7).
   *
   * **Страничности нет, и это выбор, а не забывчивость.** У пилота участник
   * ведёт единицы сделок, а не тысячи; окно и курсор — это ещё и договор о том,
   * что делать с сделкой, заведённой между двумя страницами. На сотне сделок
   * ответ всё ещё дешевле одного перехода по экрану (сотня строк — это
   * килобайты), но два места начнут скрипеть раньше остальных: у `sdelka.deal`
   * нет индекса по сторонам, поэтому выборка — проход по таблице **всех** сделок
   * базы (не участника), и стоит она размера базы, а не размера ответа; а сам
   * список к тому времени перестанет быть читаемым человеком. Оба лечатся
   * вместе — индексом по сторонам и окном с курсором по тому же порядку, что
   * объявлен здесь; порядок для этого и назван полным, чтобы курсор потом было
   * из чего собрать.
   */
  loadDealsOfParty(partyId: string): Promise<readonly DealSnapshot[]>;

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

  /** То же правило сверки, что у транша и поручения. */
  saveWithdrawal(
    snapshot: WithdrawalSnapshot,
    previous: WithdrawalSnapshot | null,
  ): Promise<WriteOutcome>;
  /**
   * Выводы клиента — списком по стороне, а не по одному номеру.
   *
   * Ключ чтения тот же, которым живёт правило: `g_no_active_withdrawal` считает
   * незавершённые выводы **по счёту клиента** (`client-account.ts`), и в схеме
   * его зеркалит частичный уникальный индекс по `party_id`. Чтение по одному
   * номеру ответа на этот вопрос не даёт — надо знать номера заранее, а после
   * перезапуска их взять неоткуда.
   */
  loadWithdrawals(partyId: string): Promise<readonly WithdrawalSnapshot[]>;
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

/**
 * Равенство состояний заявки — **по форме союза**, а не по перечню полей.
 *
 * У терминального варианта часов нет вовсе, у нетерминального они обязательны;
 * «сравнить всё, что есть» на разных вариантах сравнило бы разное. То же
 * правило и та же причина, что у `trancheStatesSame`.
 *
 * Часы входят в сравнение целиком: шаг, отличающийся от лежащего в базе только
 * сроком или возрастом, — **не повтор**. Считать его повтором значило бы
 * потерять переставленные часы молча, а на возрасте держится эскалация
 * застрявшей заявки (`DECISIONS-REVIEW.md` §H4).
 */
export function withdrawalStatesSame(left: WithdrawalState, right: WithdrawalState): boolean {
  if (left.status !== right.status) return false;
  if (left.withdrawalId !== right.withdrawalId) return false;
  if (left.idempotencyKey !== right.idempotencyKey) return false;
  if (!('deadline' in left) || !('deadline' in right)) {
    return !('deadline' in left) && !('deadline' in right);
  }
  return left.deadline.at === right.deadline.at && left.enteredAt === right.enteredAt;
}

/**
 * Равенство выводов — по всем полям снимка, а не по статусу.
 *
 * Сравнение «тот же номер и тот же статус» объявило бы повтором шаг, в котором
 * поменялась сумма или счёт-источник: у вывода на пути `requested → approved`
 * это ровно та подмена, ради запрета которой существует красная линия №9.
 */
export function withdrawalSnapshotsSame(
  left: WithdrawalSnapshot,
  right: WithdrawalSnapshot,
): boolean {
  return (
    withdrawalStatesSame(left.state, right.state) &&
    left.party.partyId === right.party.partyId &&
    left.party.accountKey === right.party.accountKey &&
    moneySame(left.amount, right.amount) &&
    left.sourceAccountFingerprint === right.sourceAccountFingerprint
  );
}
