import { type DurationMs, type Instant, type Result, duration, failure, ok } from '@sdelka/domain';
import type { AccountId, ChallengeId } from './ids';
import { type AuthReasonKey, AUTH_REASON_KEYS } from './keys';

/**
 * Доказательство личности — **одноразовый код над значением, без канала и без
 * секрета**.
 *
 * ## Зачем модуль появился
 *
 * `establishSession` принимает личность **уже доказанной**: ему передают
 * `PrimaryAuthentication` и готовые подтверждения фактора. Произвести это
 * доказательство было нечем — ни одной функции, выдающей и проверяющей код, в
 * пакете не было, поэтому «вход» существовал только как значение, которое
 * вызывающий собирал сам. Здесь появляется недостающая половина: вызов
 * (`issueChallenge`) и ответ на него (`verifyChallenge`).
 *
 * ## Что здесь есть и чего нет
 *
 * Есть: срок годности кода, счётчик попыток, однократность, разбор состояний.
 * Всё это — над значением, поэтому проверяется без сети, без базы и без часов.
 *
 * Нет **самого кода**. Его не хранит ни это значение, ни база: и то и другое
 * означало бы «секрет в схеме», что прямо запрещено
 * (`db/test/auth-reference.test.ts`, «секретов в схеме нет места»: пароль, семя
 * TOTP, одноразовый код и приватный ключ не хранятся никак — ни в открытом
 * виде, ни в необратимом). Отпечаток шестизначного кода перебирается за
 * миллисекунды, поэтому «хранить хеш» здесь не защита, а её видимость.
 *
 * Код поэтому **выводится** из вызова ключом, живущим только в окружении
 * (красная линия №12) — порт `CodeDerivation`, реализация в `code.ts`. Утечка
 * базы кодов не даёт; утечка ключа даёт, и ровно поэтому ключ не лежит нигде,
 * кроме окружения процесса.
 *
 * Нет **канала доставки**: он за портом (`delivery.ts`), и порт без боевого
 * адаптера отказывает на старте, а не печатает код в лог молча.
 */

/**
 * Правила одноразового кода.
 *
 * Три числа, и каждое ограничивает подбор со своей стороны: срок — окно, в
 * котором код вообще что-то значит; число попыток — сколько догадок принимается
 * внутри окна; длина — размер пространства. Шесть знаков при пяти попытках и
 * десяти минутах дают 5·10⁻⁶ на вызов; удлинение кода без ограничения попыток
 * не даёт ничего — перебор идёт по попыткам, а не по знакам.
 *
 * Однократность стоит рядом и не выражена числом: код, принятый один раз,
 * второй раз не принимается никогда (`consumedAt`). Без неё перехваченный код
 * годится до конца срока, то есть срок превращается в окно повтора.
 */
export interface IdentityCodePolicy {
  readonly ttl: DurationMs;
  readonly maxAttempts: number;
  readonly codeLength: number;
}

export const IDENTITY_CODE_POLICY: IdentityCodePolicy = Object.freeze({
  ttl: duration(10 * 60 * 1000),
  maxAttempts: 5,
  codeLength: 6,
});

/**
 * Вызов, на который отвечают кодом.
 *
 * Персональных данных здесь нет ни в одном поле: `accountId` непрозрачен по
 * построению (`ids.ts`), адреса доставки в значении нет вовсе — его знает
 * адаптер канала, а не решение.
 */
export interface IdentityChallenge {
  readonly challengeId: ChallengeId;
  readonly accountId: AccountId;
  readonly issuedAt: Instant;
  /** Абсолютный срок. Продлению не подлежит — продлеваемый срок не срок. */
  readonly expiresAt: Instant;
  readonly attemptsUsed: number;
  readonly maxAttempts: number;
  /** Момент, когда код был принят. После него вызов не отвечается никогда. */
  readonly consumedAt: Instant | null;
}

/**
 * Состояние вызова. Четыре, а не «годен / не годен»: причины отказа разные, и
 * журналу нужна именно причина, а не факт.
 */
export type ChallengeStatus = 'pending' | 'expired' | 'consumed' | 'exhausted';

export interface ChallengeRequest {
  readonly challengeId: ChallengeId;
  readonly accountId: AccountId;
  readonly issuedAt: Instant;
}

export function issueChallenge(
  request: ChallengeRequest,
  policy: IdentityCodePolicy = IDENTITY_CODE_POLICY,
): IdentityChallenge {
  return Object.freeze({
    challengeId: request.challengeId,
    accountId: request.accountId,
    issuedAt: request.issuedAt,
    expiresAt: (request.issuedAt + policy.ttl) as Instant,
    attemptsUsed: 0,
    maxAttempts: policy.maxAttempts,
    consumedAt: null,
  });
}

/**
 * Порядок разбора не косметический.
 *
 * `consumed` идёт первым: код, уже принятый, не должен получать ответ
 * «истёк» — по разнице ответов повтор отличается от подбора, а нам обе
 * попытки одинаково безразличны на экране и одинаково важны в журнале.
 * `exhausted` идёт перед `expired` по той же причине: исчерпание попыток —
 * след подбора, и он не должен теряться под сроком.
 */
export function challengeStatus(challenge: IdentityChallenge, now: Instant): ChallengeStatus {
  if (challenge.consumedAt !== null) return 'consumed';
  if (challenge.attemptsUsed >= challenge.maxAttempts) return 'exhausted';
  if (now >= challenge.expiresAt) return 'expired';
  return 'pending';
}

/** Ключ причины по состоянию. `pending` причины не имеет — он не отказ. */
export function challengeRejection(status: ChallengeStatus): AuthReasonKey | null {
  switch (status) {
    case 'pending':
      return null;
    case 'expired':
      return AUTH_REASON_KEYS.identityChallengeExpired;
    case 'consumed':
      return AUTH_REASON_KEYS.identityChallengeConsumed;
    case 'exhausted':
      return AUTH_REASON_KEYS.identityAttemptsExhausted;
  }
}

/**
 * Вывод кода из вызова — **порт, а не функция**.
 *
 * Реализации здесь нет: она требует ключа, ключ живёт в окружении, а пакет,
 * читающий окружение, невозможно проверить без окружения. Порт объявлен над
 * значением, поэтому подделка в тесте — три строки без крипты и без секрета.
 */
export interface CodeDerivation {
  /** Код вызова. Значение не попадает ни в журнал, ни в отказ, ни в отчёт. */
  codeFor(challenge: IdentityChallenge): string;
  /** Сравнение ответа с кодом. Обязано идти за постоянное время. */
  matches(challenge: IdentityChallenge, submitted: string): boolean;
}

/**
 * Исход проверки — **пара «новое состояние вызова» и «ответ»**, а не одно из
 * двух.
 *
 * Состояние возвращается всегда, включая отказ, и вызывающий обязан его
 * записать: несовпавший код **тратит попытку**, и попытка, не доехавшая до
 * хранилища, — это счётчик, который не считает. Ровно так подбор и переживает
 * ограничение: код не совпал, ошибка показана, счётчик остался нулём.
 */
export interface ChallengeVerification {
  readonly challenge: IdentityChallenge;
  readonly outcome: Result<IdentityChallenge, AuthReasonKey>;
}

/**
 * Ответ на вызов.
 *
 * Отказ — значение с ключом причины: у экрана причина одна на все
 * (`identityRejected`, см. `uniformIdentityRejection`), у журнала — та, что
 * здесь. Разные ответы экрану выдают наличие учётной записи и состояние
 * подбора; одинаковые ответы журналу не дают расследовать инцидент. Поэтому
 * разделение проходит здесь, а не в транспорте.
 */
export function verifyChallenge(
  challenge: IdentityChallenge,
  submitted: string,
  derivation: CodeDerivation,
  now: Instant,
): ChallengeVerification {
  const status = challengeStatus(challenge, now);
  const rejection = challengeRejection(status);
  if (rejection !== null) {
    // Попытка не засчитывается: вызов и так закрыт, а счётчик, растущий после
    // закрытия, превращает истёкший вызов в вечный источник «исчерпано».
    return Object.freeze({ challenge, outcome: failure(rejection) });
  }
  if (!derivation.matches(challenge, submitted)) {
    const attempted: IdentityChallenge = Object.freeze({
      ...challenge,
      attemptsUsed: challenge.attemptsUsed + 1,
    });
    return Object.freeze({
      challenge: attempted,
      outcome: failure(AUTH_REASON_KEYS.identityCodeMismatch),
    });
  }
  const consumed: IdentityChallenge = Object.freeze({
    ...challenge,
    attemptsUsed: challenge.attemptsUsed + 1,
    consumedAt: now,
  });
  return Object.freeze({ challenge: consumed, outcome: ok(consumed) });
}

/**
 * Единый ответ экрану на любой отказ во входе.
 *
 * «Такого лица нет» и «код неверен» обязаны быть неразличимы снаружи: разница
 * между ними — это перечислитель учётных записей, которому не нужен ни один
 * код. Разница сохраняется там, где она нужна, — в журнале входов, куда экран
 * не смотрит.
 */
export const uniformIdentityRejection: AuthReasonKey = AUTH_REASON_KEYS.identityRejected;
