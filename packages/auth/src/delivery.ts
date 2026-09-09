import type { Instant } from '@sdelka/domain';
import type { IdentityChallenge } from './challenge';
import { AuthError, AuthErrorCode } from './errors';
import type { AccountId, ChallengeId } from './ids';

/**
 * Канал доставки одноразового кода — **порт, и порт без адаптера отказывает**.
 *
 * ## Почему отказывает, а не молчит
 *
 * Заглушка, печатающая код в журнал процесса, — это работающая с виду
 * аутентификация, в которой код знает каждый, у кого есть доступ к логам. В
 * разработке это ровно то, что нужно; в бою это дыра, и хуже всего то, что она
 * **не видна**: экран ведёт себя правильно, тесты зелёные, вход происходит.
 *
 * Поэтому режим объявлен значением, а не выведен из наличия адаптера:
 * `resolveCodeDelivery` в боевом режиме без адаптера **бросает на старте**.
 * Отказ на старте видит один человек за минуту; тихая заглушка — все и потом.
 *
 * ## Чего в порту нет
 *
 * Адреса. Ни почты, ни телефона, ни имени: пакет их не знает и знать не должен
 * (`ids.ts` — идентификаторы непрозрачны, персональные данные не переживают
 * границу пакета). Адаптер получает **учётную запись** и находит адрес сам, у
 * себя; там же живут его ключи — в окружении (красная линия №12).
 *
 * Текста. Адаптер получает **ключ назначения**, а не строку: три языка
 * (`CLAUDE.md`), и перевод делает тот, кто знает язык получателя.
 */

/**
 * Режим работы канала. Два значения, и оба названы: «не задано» здесь означало
 * бы «как-нибудь», а как-нибудь у канала аутентификации не бывает.
 */
export type DeliveryMode = 'development' | 'production';

export const DELIVERY_MODES: readonly DeliveryMode[] = Object.freeze([
  'development',
  'production',
]);

export function isDeliveryMode(value: string): value is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

export interface CodeDeliveryRequest {
  readonly accountId: AccountId;
  readonly challengeId: ChallengeId;
  /** Сам код. Дальше порта не уходит: ни в журнал, ни в отчёт, ни в отказ. */
  readonly code: string;
  readonly expiresAt: Instant;
  /** Зачем код. Ключ, а не текст: перевод — на стороне адаптера. */
  readonly purposeKey: string;
  /** Язык получателя тегом локали. Выбор языка — не догадка адаптера. */
  readonly locale: string;
}

export interface CodeDeliveryPort {
  deliver(request: CodeDeliveryRequest): Promise<void>;
}

/** Назначение кода. Перечень закрытый: свободной строки в журнале не бывает. */
export const CODE_PURPOSE_KEYS = {
  signIn: 'auth.code.purpose.sign_in',
} as const;

export type CodePurposeKey = (typeof CODE_PURPOSE_KEYS)[keyof typeof CODE_PURPOSE_KEYS];

/** Куда пишет отладочный канал. Функция, а не `console`: подделывается в тесте. */
export type CodeSink = (line: string) => void;

/**
 * Строка отладочного канала. Формат стабильный и разбираемый грепом: её читает
 * разработчик, а не клиент, поэтому текста здесь нет — только ключи и значения.
 */
export function developmentDeliveryLine(request: CodeDeliveryRequest): string {
  return [
    'auth.code.delivered_to_log',
    `account=${request.accountId}`,
    `challenge=${request.challengeId}`,
    `purpose=${request.purposeKey}`,
    `locale=${request.locale}`,
    `expires_at=${String(request.expiresAt)}`,
    `code=${request.code}`,
  ].join(' ');
}

/**
 * Отладочный канал: код уходит в журнал процесса.
 *
 * Собирается **только** в режиме разработки, и это проверяется здесь, а не
 * договорённостью: собранный в бою, он был бы той самой невидимой дырой.
 */
export function developmentCodeDelivery(sink: CodeSink, mode: DeliveryMode): CodeDeliveryPort {
  if (mode === 'production') {
    throw new AuthError(AuthErrorCode.codeDeliveryNotForProduction, { mode });
  }
  return Object.freeze({
    deliver(request: CodeDeliveryRequest): Promise<void> {
      sink(developmentDeliveryLine(request));
      return Promise.resolve();
    },
  });
}

export interface CodeDeliveryResolution {
  readonly mode: DeliveryMode;
  /** Боевой адаптер. Сегодня его нет ни одного — отсюда `null` и отказ. */
  readonly adapter: CodeDeliveryPort | null;
  readonly sink: CodeSink;
}

/**
 * Выбор канала на старте процесса.
 *
 * Боевой режим без адаптера — **отказ**, а не откат к журналу процесса. Это и
 * есть ворота: пока боевого адаптера нет, приложение в боевом режиме не
 * поднимается, и отсутствие канала невозможно не заметить.
 */
export function resolveCodeDelivery(resolution: CodeDeliveryResolution): CodeDeliveryPort {
  if (resolution.adapter !== null) return resolution.adapter;
  if (resolution.mode === 'production') {
    throw new AuthError(AuthErrorCode.codeDeliveryAdapterMissing, { mode: resolution.mode });
  }
  return developmentCodeDelivery(resolution.sink, resolution.mode);
}

/**
 * Запрос доставки по вызову. Код берётся у `CodeDerivation` вызывающим и сюда
 * приходит значением: функция ничего не выводит и ничего не хранит.
 */
export function deliveryFor(
  challenge: IdentityChallenge,
  code: string,
  purposeKey: CodePurposeKey,
  locale: string,
): CodeDeliveryRequest {
  return Object.freeze({
    accountId: challenge.accountId,
    challengeId: challenge.challengeId,
    code,
    expiresAt: challenge.expiresAt,
    purposeKey,
    locale,
  });
}
