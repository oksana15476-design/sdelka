import { AuthError, AuthErrorCode } from './errors';

/**
 * Идентификаторы аутентификации — **непрозрачные ключи, а не логины**.
 *
 * Основание не стилистическое. События входа уходят в журнал аудита, журнал не
 * редактируется никем (красная линия №11), значит всё, что в него попало,
 * останется там навсегда. Адрес почты, телефон и имя — персональные данные, и
 * `packages/audit/src/values.ts` уже запрещает им форму: пробелов нет, `@` нет.
 * Здесь то же правило на входе в пакет, а не на выходе из него: если бы
 * `accountId` мог быть почтой, запрет в аудите ловил бы её на последнем метре,
 * когда решение уже принято и залогировано вызывающим.
 */
const OPAQUE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]{0,127}$/u;

declare const accountBrand: unique symbol;
declare const personBrand: unique symbol;
declare const sessionBrand: unique symbol;
declare const challengeBrand: unique symbol;
declare const fingerprintBrand: unique symbol;

/** Учётная запись. Разделение обязанностей проходит по ней в первом рубеже. */
export type AccountId = string & { readonly [accountBrand]: 'account' };

/**
 * Человек за учётной записью — второй рубеж того же разделения.
 *
 * `ACTORS.md` §9 случай 5 утверждает, что «ОР внёс наблюдение и он же ФК»
 * технически невозможно, потому что это разные учётные записи. Это верно ровно
 * до дня, когда один человек получит обе: при 0,07 FTE у руководителя операций
 * (§6.8) и 0,3 FTE у комплаенс-офицера (§6.6) совмещение **по времени** прямо
 * предусмотрено документом. Учётные записи разные, человек один — и правило,
 * стоящее только на `accountId`, в этот день перестаёт работать молча.
 *
 * Поэтому несовместимости проверяются по паре: совпадение либо учётной записи,
 * либо человека — уже нарушение. Связь «учётная запись → человек» приходит
 * снаружи; если её нет, вызывающий обязан дать разные значения, а не одно на всех.
 */
export type PersonId = string & { readonly [personBrand]: 'person' };

export type SessionId = string & { readonly [sessionBrand]: 'session' };
export type ChallengeId = string & { readonly [challengeBrand]: 'challenge' };

/**
 * Отпечаток устройства или сетевого адреса. Значения не хранятся: `ACTORS.md`
 * §4.1 A2 и инвариант 24 — в журнал идут отпечатки, а не сырые идентификаторы.
 * Форма — 64 знака шестнадцатеричной записи, как у `Sha256Hex` в аудите;
 * вычисление отпечатка живёт там, где есть сырое значение, то есть не здесь.
 */
export type Fingerprint = string & { readonly [fingerprintBrand]: 'fingerprint' };

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function accountId(value: string): AccountId {
  if (!OPAQUE_KEY.test(value)) {
    // Значение в детали не кладём: если сюда прилетела строка с `@`, это почта.
    throw new AuthError(AuthErrorCode.accountIdInvalid);
  }
  return value as AccountId;
}

export function personId(value: string): PersonId {
  if (!OPAQUE_KEY.test(value)) {
    throw new AuthError(AuthErrorCode.personIdInvalid);
  }
  return value as PersonId;
}

export function sessionId(value: string): SessionId {
  if (!OPAQUE_KEY.test(value)) {
    throw new AuthError(AuthErrorCode.sessionIdInvalid);
  }
  return value as SessionId;
}

export function challengeId(value: string): ChallengeId {
  if (!OPAQUE_KEY.test(value)) {
    throw new AuthError(AuthErrorCode.challengeIdInvalid);
  }
  return value as ChallengeId;
}

export function fingerprint(value: string): Fingerprint {
  if (!SHA256_HEX.test(value)) {
    throw new AuthError(AuthErrorCode.fingerprintInvalid);
  }
  return value as Fingerprint;
}

/**
 * Ссылка на действующее лицо: учётная запись **и** человек за ней.
 * Обе части обязательны типом — см. оговорку у `PersonId`.
 */
export interface ActorRef {
  readonly accountId: AccountId;
  readonly personId: PersonId;
}

export function actorRef(account: AccountId, person: PersonId): ActorRef {
  return Object.freeze({ accountId: account, personId: person });
}

/**
 * Признание «мне это неизвестно» — **третье значение рядом с «кто-то» и «никто»**.
 *
 * Без него перечень лиц несёт два несовместимых смысла сразу: пустой перечень
 * читается и как «никто этого не делал», и как «вызывающий не выяснял». Первое —
 * утверждение, за которое вызывающий отвечает; второе — признание, что проверять
 * нечем. Правило, получившее второе под видом первого, отключается молчанием, и
 * именно так отключалось разделение обязанностей: вызов без контекста.
 *
 * Поэтому «неизвестно» выражено значением, а решение, которому оно досталось,
 * **отказывает**. Направление отказа то же, что у красной линии №7: бездействие
 * не превращается в разрешение.
 */
export const UNKNOWN_FACT = 'unknown' as const;
export type UnknownFact = typeof UNKNOWN_FACT;

/**
 * Ответ на вопрос «кто это делал»: перечень лиц (возможно пустой — «никто») либо
 * `UNKNOWN_FACT`. Третьего способа промолчать нет: поле обязательно типом.
 */
export type ActorFact = readonly ActorRef[] | UnknownFact;

/** Одно и то же действующее лицо: совпала учётная запись **или** человек. */
export function sameActor(left: ActorRef, right: ActorRef): boolean {
  return left.accountId === right.accountId || left.personId === right.personId;
}

export function includesActor(haystack: readonly ActorRef[], needle: ActorRef): boolean {
  return haystack.some((candidate) => sameActor(candidate, needle));
}
