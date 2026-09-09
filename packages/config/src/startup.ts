import { ConfigError, ConfigErrorCode } from './errors.ts';
import { Presence, presenceOf } from './presence.ts';
import { ENV_REGISTRY, type EnvScope, type EnvVariable, requiredVariables } from './registry.ts';

/**
 * Проверка окружения на старте.
 *
 * Правило одно и оно жёсткое: **не хватает обязательной переменной — процесс не
 * поднимается**. Умолчание, подставленное вместо недостающего секрета, — худший
 * из исходов: процесс встаёт, отвечает на запросы и ведёт себя не так, как
 * думает тот, кто его развернул. Отказ на старте видит один человек за одну
 * минуту; молчаливое умолчание — все и потом.
 *
 * Отказ собирает **весь** список за один проход. Проверка, падающая на первой
 * же переменной, превращает разворачивание в перебор: завёл одну — перезапустил
 * — узнал про вторую.
 *
 * Ни в отчёте, ни в исключении, ни в тексте отказа нет значений — только имена
 * (красная линия №12).
 */

export type EnvFault = {
  readonly variable: string;
  /** Только `absent` или `blank`: `present` — не изъян. */
  readonly presence: Exclude<Presence, 'present'>;
  readonly readBy: readonly string[];
};

export type EnvironmentCheck = {
  readonly scope: EnvScope;
  readonly ok: boolean;
  readonly faults: readonly EnvFault[];
};

/** Куда отсылает отказ. Файл лежит в корне репозитория. */
export const ENV_REFERENCE = '.env.example';

function faultOf(variable: EnvVariable, presence: Exclude<Presence, 'present'>): EnvFault {
  return { variable: variable.name, presence, readBy: variable.readBy };
}

/**
 * Осмотр без последствий: считает изъяны и возвращает отчёт. Ничего не пишет и
 * не бросает — этим пользуются тесты и любой, кому нужен ответ, а не отказ.
 */
export function checkEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  scope: EnvScope = 'app',
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): EnvironmentCheck {
  const faults: EnvFault[] = [];
  for (const variable of requiredVariables(scope, registry)) {
    const presence = presenceOf(env, variable.name);
    if (presence === Presence.present) continue;
    faults.push(faultOf(variable, presence));
  }
  return { scope, ok: faults.length === 0, faults };
}

/**
 * Проверка по именам вместо области: процесс объявляет, что читает сам.
 *
 * Область — грубая мерка. `app` объединяет всё, что нужно приложению, а шагов
 * у приложения несколько, и читают они разное: накату миграций нужна строка
 * подключения и больше ничего. Требовать от него переменные входа значит
 * заставить выставить туда любое значение, то есть научить обходить ворота.
 *
 * Перечень остаётся один и тот же: имена сверяются с ним вызывающим
 * (`findEnvVariable`), незнакомое имя сюда не доезжает.
 */
export function checkNamedEnvironment(
  names: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): EnvironmentCheck {
  const wanted = new Set(names);
  const faults: EnvFault[] = [];
  for (const variable of registry) {
    if (!wanted.has(variable.name)) continue;
    if (variable.necessity !== 'required') continue;
    const presence = presenceOf(env, variable.name);
    if (presence === Presence.present) continue;
    faults.push(faultOf(variable, presence));
  }
  return { scope: 'app', ok: faults.length === 0, faults };
}

/**
 * Текст отказа. Технические ключи и имена — не прозаическое сообщение и тем
 * более не пользовательский текст (CLAUDE.md, «Три языка»): читает его тот, кто
 * разворачивает, и ему нужны имя переменной, вид изъяна и кому её не хватило.
 *
 * Формат намеренно построчный и стабильный: такой отказ читается и человеком, и
 * грепом в сборщике логов.
 */
export function describeEnvironmentCheck(check: EnvironmentCheck): string {
  const head = `${ConfigErrorCode.envIncomplete} scope=${check.scope} count=${check.faults.length} reference=${ENV_REFERENCE}`;
  const lines = check.faults.map((fault) => {
    const code =
      fault.presence === Presence.absent ? ConfigErrorCode.envAbsent : ConfigErrorCode.envBlank;
    return `${fault.variable} ${code} read_by=${fault.readBy.join(',')}`;
  });
  return [head, ...lines].join('\n');
}

/** Имена изъянов одного вида, через запятую. Для `details` исключения. */
function namesWith(check: EnvironmentCheck, presence: Exclude<Presence, 'present'>): string {
  return check.faults
    .filter((fault) => fault.presence === presence)
    .map((fault) => fault.variable)
    .join(',');
}

/**
 * То же, но для тех, кому без окружения делать нечего: точка входа процесса.
 * Бросает `ConfigError` с полным списком имён; значений в исключении нет.
 */
export function assertEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  scope: EnvScope = 'app',
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): void {
  const check = checkEnvironment(env, scope, registry);
  if (check.ok) return;
  throw new ConfigError(ConfigErrorCode.envIncomplete, {
    scope: check.scope,
    absent: namesWith(check, Presence.absent),
    blank: namesWith(check, Presence.blank),
    reference: ENV_REFERENCE,
  });
}
