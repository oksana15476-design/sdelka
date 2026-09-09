import type { Instant } from '@sdelka/domain';
import type { IdentityChallenge } from './challenge';
import type { AuthEvent } from './events';
import type { AccountId, ChallengeId, PersonId } from './ids';
import type { RoleId } from './roles';
import type { SessionStorePort } from './session';

/**
 * Порты хранилища входа — **объявлены здесь, реализованы не здесь**.
 *
 * ## Почему в этом пакете
 *
 * Тот же довод, что у `WorldStore` в `packages/db` (`store/port.ts`): порт
 * объявляется над словарём, который знают **обе** стороны границы. Здесь этот
 * словарь — сам `@sdelka/auth`: учётная запись, сессия, вызов, событие журнала.
 * Ни одного типа из `@sdelka/app` и ни одного из `@sdelka/db` в файле нет,
 * поэтому объявление не заводит ребра ни туда, ни оттуда: хранилище зависит от
 * пакета аутентификации, а не наоборот.
 *
 * `SessionStorePort` при этом остаётся объявленным в `session.ts`, где он и был:
 * переезд ради красоты сломал бы импорты, ничего не добавив. Здесь он только
 * собирается вместе с остальными в одну транзакцию.
 *
 * ## Почему транзакция, а не четыре независимых вызова
 *
 * Вход — это один шаг, а не четыре. Записанная попытка, не доехавший до
 * хранилища счётчик и выданная сессия без записи в журнале — три разных вида
 * лжи, и каждый получается сам собой, если каждая часть пишется отдельно.
 * Поэтому у хранилища одна дверь: `transact`, внутри которой либо ложится всё,
 * либо не ложится ничего.
 */

/**
 * Учётная запись в том виде, в каком её знает вход: кто, какой человек за ней и
 * какая у неё роль.
 *
 * Ни адреса, ни телефона, ни имени: их знает адаптер канала доставки, а решение
 * о входе не знает и знать не должно (`ids.ts`).
 */
export interface AccountRecord {
  readonly accountId: AccountId;
  readonly personId: PersonId;
  readonly roleId: RoleId;
}

/**
 * Справочник учётных записей.
 *
 * `null` — записи нет. Отказ, а не исключение: «такой записи нет» — обычный
 * исход входа, и снаружи он обязан выглядеть точно так же, как неверный код.
 */
export interface AccountDirectoryPort {
  find(accountKey: string): Promise<AccountRecord | null>;
}

/**
 * Хранилище вызовов.
 *
 * `save` пишет и новый вызов, и его изменённое состояние: попытка засчитана,
 * код принят, доставка отмечена. Разделять «создать» и «обновить» здесь нечего —
 * состояние вызова целиком лежит в значении, а правила движения (счётчик только
 * вперёд, принятый не оживает) держит база.
 */
export interface IdentityChallengeStorePort {
  load(id: ChallengeId): Promise<IdentityChallenge | null>;
  /**
   * Самый свежий вызов учётной записи — **в любом состоянии**, а не только
   * живой.
   *
   * По нему считается ограничение потока запросов «пришлите код»
   * (`code-request.ts`): живой возвращается тому, кто попросил повторно, а
   * закрытый нужен ради своей отметки об отправке — без неё «вызов закрыт»
   * читалось бы как «отправлять можно», и пять неверных ответов открывали бы
   * канал заново.
   */
  latestFor(account: AccountId): Promise<IdentityChallenge | null>;
  save(challenge: IdentityChallenge): Promise<void>;
  /**
   * Отметить, что канал принял код к доставке.
   *
   * Ставится на **каждую** отправку, включая повторную: отметка отвечает на
   * вопрос «когда сообщили последний раз», и неподвижная делает окно повторной
   * отправки бесконечным (`0025`). Назад отметка не двигается — это держит
   * триггер, а не вызывающий.
   */
  markDelivered(id: ChallengeId, at: Instant): Promise<void>;
}

/**
 * Журнал входов.
 *
 * Только дополнение: ни изменения, ни удаления в порту нет — красная линия №11
 * выражена **отсутствием методов**, а не запретом в комментарии. То же держит и
 * база: у роли приложения на `sdelka.auth_event` есть `SELECT` и `INSERT` и
 * нет ничего больше (`0010`).
 */
export interface AuthJournalPort {
  append(event: AuthEvent): Promise<void>;
}

export interface AuthTransaction {
  readonly accounts: AccountDirectoryPort;
  readonly challenges: IdentityChallengeStorePort;
  readonly sessions: SessionStorePort;
  readonly journal: AuthJournalPort;
}

export interface AuthStore {
  transact<T>(body: (tx: AuthTransaction) => Promise<T>): Promise<T>;
}
