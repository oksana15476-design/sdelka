import type { Instant } from '@sdelka/domain';
import type { ChallengeId, Fingerprint } from './ids';

/**
 * Второй фактор — **порт, а не интеграция**.
 *
 * В этом файле нет ни одного сетевого вызова, ни одного секрета и ни одной
 * реализации. Провайдер (WebAuthn-релая, отправка кода, push) — отдельная
 * карточка со своим дизайн-доком до кода, и его секреты живут в окружении
 * (красная линия №12). Здесь живёт только то, что нужно **решению**: какой
 * фактор предъявлен, когда он был подтверждён и достаточно ли он силён.
 *
 * Логика поэтому синхронная и проверяется без сети: порт выдаёт `SecondFactorAssertion`,
 * а все правила работают уже над готовым значением.
 */

/**
 * Виды факторов и их устойчивость к фишингу.
 *
 * Разделение существенно, а не декоративно. `ACTORS.md` §11 Р6 вариант B
 * («одноразовый код на почту») забракован прямым доводом: он защищает от чего
 * угодно, кроме сценария, который нас убивает, — компрометация деловой переписки
 * **и есть** доступ к почте. Тот же довод переносится на SMS и на код в
 * мессенджере: канал, который может быть у нападающего, не является вторым
 * фактором, он является вторым экраном.
 */
export const SECOND_FACTOR_KINDS = [
  /** Ключ или платформенный аутентификатор. Привязан к домену — фишингу не отдаётся. */
  'webauthn',
  /** Код из приложения. Не отдаётся перехвату канала, отдаётся живому фишингу. */
  'totp',
  /** Подтверждение в нашем приложении с показом контекста операции. */
  'push',
  /** Код в SMS. Перехватывается подменой SIM. */
  'sms',
  /** Код в письме. См. Р6 B. */
  'email',
] as const;
export type SecondFactorKind = (typeof SECOND_FACTOR_KINDS)[number];

export type FactorStrength = 'phishing_resistant' | 'possession' | 'channel';

export const FACTOR_STRENGTH: Readonly<Record<SecondFactorKind, FactorStrength>> = Object.freeze({
  webauthn: 'phishing_resistant',
  totp: 'possession',
  push: 'possession',
  sms: 'channel',
  email: 'channel',
});

/** Порядок строгости. Сравнение по нему, а не по имени вида. */
const STRENGTH_ORDER: Readonly<Record<FactorStrength, number>> = Object.freeze({
  channel: 0,
  possession: 1,
  phishing_resistant: 2,
});

export function atLeastAsStrong(kind: SecondFactorKind, minimum: FactorStrength): boolean {
  return STRENGTH_ORDER[FACTOR_STRENGTH[kind]] >= STRENGTH_ORDER[minimum];
}

/**
 * Первичное подтверждение входа — «чем подтвердил».
 *
 * `magic_link` (ссылка в письме) для консольных ролей запрещён по тому же
 * доводу Р6 B: почта — компрометируемый канал, а консольная роль видит деньги.
 * Запрет проверяется в `session.ts`, а не здесь: здесь перечень, там правило.
 */
export const PRIMARY_METHODS = ['passkey', 'password', 'federated', 'magic_link'] as const;
export type PrimaryMethod = (typeof PRIMARY_METHODS)[number];

export interface PrimaryAuthentication {
  readonly method: PrimaryMethod;
  readonly at: Instant;
  /** Отпечаток устройства. Сырых значений в пакете нет — см. `ids.ts`. */
  readonly device: Fingerprint | null;
  readonly network: Fingerprint | null;
}

/**
 * Подтверждение второго фактора. Выдаётся портом, дальше живёт как значение.
 *
 * `challengeId` обязателен: подтверждение без вызова, на который оно отвечает,
 * невозможно связать с операцией, и повтор такого подтверждения нечем отличить
 * от первого.
 */
export interface SecondFactorAssertion {
  readonly kind: SecondFactorKind;
  readonly challengeId: ChallengeId;
  readonly verifiedAt: Instant;
  readonly device: Fingerprint | null;
}

export interface SecondFactorChallenge {
  readonly challengeId: ChallengeId;
  readonly kind: SecondFactorKind;
  readonly issuedAt: Instant;
  readonly expiresAt: Instant;
}

export interface SecondFactorChallengeRequest {
  readonly kind: SecondFactorKind;
  /**
   * Что именно подтверждается. Ключ операции, а не текст: `CLAUDE.md` —
   * пользовательский текст живёт в словарях локализации. Провайдер, показывающий
   * человеку «подтвердите операцию», обязан получить ключ и перевести его сам.
   */
  readonly purposeKey: string;
  readonly issuedAt: Instant;
}

/**
 * Порт второго фактора. Реализаций в этом пакете нет и не будет.
 *
 * Что порт **не** делает: не решает, нужен ли фактор (это `capabilities.ts`), не
 * решает, достаточно ли он свеж (это `session.ts`), не хранит привязку. Он
 * выдаёт вызов и проверяет ответ — и всё.
 */
export interface SecondFactorPort {
  challenge(request: SecondFactorChallengeRequest): Promise<SecondFactorChallenge>;
  verify(challenge: SecondFactorChallenge, response: string): Promise<SecondFactorAssertion>;
}

/**
 * Привязка фактора к учётной записи — тоже порт.
 *
 * `ACTORS.md` §11 Р6 вариант A (рекомендуемый): **обязательная привязка второго
 * фактора до первого ввода реквизитов**. Значит система обязана уметь ответить
 * на вопрос «привязан ли фактор» до того, как покажет форму, а не после того,
 * как человек её заполнил.
 */
export interface SecondFactorBinding {
  readonly kind: SecondFactorKind;
  readonly boundAt: Instant;
}

export interface SecondFactorRegistryPort {
  bindingsFor(accountKey: string): Promise<readonly SecondFactorBinding[]>;
}

/** Свежайшее подтверждение из набора. Пустой набор — `null`, а не исключение. */
export function freshestAssertion(
  assertions: readonly SecondFactorAssertion[],
): SecondFactorAssertion | null {
  let freshest: SecondFactorAssertion | null = null;
  for (const assertion of assertions) {
    if (freshest === null || assertion.verifiedAt > freshest.verifiedAt) {
      freshest = assertion;
    }
  }
  return freshest;
}
