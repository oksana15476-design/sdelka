import { ConfigError, ConfigErrorCode } from './errors.ts';

/**
 * Перечень переменных окружения — **один на весь монорепозиторий**.
 *
 * До этого файла перечня не было: строка подключения жила в `packages/db`,
 * пароль локального кластера — в shell-скрипте, мутационные стенды — каждый в
 * своём. Развернуть по такому «перечню» нельзя: узнать, что ещё читается,
 * можно было только грепом. Здесь ровно то, что читается кодом или скриптами,
 * и ничего сверх (`test/drift.test.ts` сверяет перечень с деревом).
 *
 * **Значений здесь нет и быть не может** (красная линия №12). Есть имена, есть
 * ответ «что будет, если не задана», и для несекретных — объявленное умолчание
 * читателя. У секрета поле умолчания обязано быть пустым: умолчание вместо
 * пароля или ключа — это секрет в репозитории, просто написанный мелко
 * (`test/registry.test.ts` это проверяет, а не подразумевает).
 */

/**
 * Где переменная нужна.
 *
 * - `app` — процесс приложения. Отсутствие обязательной здесь = процесс не
 *   поднимается (`startup.ts`).
 * - `tooling` — разработка, тесты, стенды, локальный кластер. Отсутствие никого
 *   не роняет: у инструмента есть объявленное поведение без переменной.
 *
 * Третьей области («миграции») намеренно нет: миграции ходят в ту же базу по
 * той же строке, и вторая область означала бы вторую строку подключения,
 * которая рано или поздно разъедется с первой (см. `db/src/env.ts`).
 */
export type EnvScope = 'app' | 'tooling';

/** Обязательна ли переменная в своей области. */
export type EnvNecessity = 'required' | 'optional';

export type EnvVariable = {
  readonly name: string;
  readonly scope: EnvScope;
  readonly necessity: EnvNecessity;
  /**
   * Значение переменной — секрет: пароль, ключ, токен, реквизит или строка, в
   * которой всё это лежит. Секрет не печатается никогда и никуда: ни в ошибку,
   * ни в журнал, ни в вывод проверки.
   */
  readonly secret: boolean;
  /**
   * Что подставляет **читатель**, если переменной нет. `null` — не подставляет
   * ничего: либо отказ (для обязательных), либо объявленное поведение без
   * значения (см. `.env.example`). У секрета всегда `null`.
   */
  readonly fallback: string | null;
  /** Кто читает. Печатается в отказе: чинить проще, когда видно, кому не хватило. */
  readonly readBy: readonly string[];
};

export const ENV_REGISTRY: readonly EnvVariable[] = Object.freeze([
  /* ── База ──────────────────────────────────────────────────────────────── */
  Object.freeze({
    name: 'SDELKA_DATABASE_URL',
    scope: 'app',
    necessity: 'required',
    secret: true,
    fallback: null,
    readBy: Object.freeze([
      'packages/db/src/env.ts',
      'packages/db/src/cli/migrate.ts',
      'packages/db/vitest.int.config.ts',
      'packages/e2e/vitest.int.config.ts',
    ]),
  }),

  /* ── Локальный кластер: packages/db/scripts/dev-db.sh ──────────────────── */
  Object.freeze({
    name: 'SDELKA_DB_NAME',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: 'sdelka_dev',
    readBy: Object.freeze(['packages/db/scripts/dev-db.sh']),
  }),
  Object.freeze({
    name: 'SDELKA_DB_USER',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: 'sdelka_dev',
    readBy: Object.freeze(['packages/db/scripts/dev-db.sh']),
  }),
  Object.freeze({
    name: 'SDELKA_DB_HOST',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: '127.0.0.1',
    readBy: Object.freeze(['packages/db/scripts/dev-db.sh']),
  }),
  Object.freeze({
    name: 'SDELKA_DB_PORT',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: '5432',
    readBy: Object.freeze(['packages/db/scripts/dev-db.sh']),
  }),
  Object.freeze({
    name: 'SDELKA_PG_CLUSTER',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: '16 main',
    readBy: Object.freeze(['packages/db/scripts/dev-db.sh']),
  }),
  Object.freeze({
    name: 'SDELKA_DB_PASSWORD',
    scope: 'tooling',
    necessity: 'optional',
    secret: true,
    // Умолчания нет и не будет: пароль по умолчанию — это пароль в репозитории.
    // Без переменной скрипт заводит роль под peer-аутентификацию, а не под
    // «postgres/postgres».
    fallback: null,
    // `compose.yaml` читает её же: у стека из контейнеров тот же локальный
    // кластер, только в контейнере. Там она обязательна — `${...:?}` не даёт
    // стеку подняться без неё; здесь необязательна, потому что `dev-db.sh`
    // имеет объявленное поведение без пароля (peer-аутентификация).
    readBy: Object.freeze([
      'packages/db/scripts/dev-db.sh',
      'compose.yaml',
      'docker/postgres-init.sh',
    ]),
  }),

  /* ── Мутационные стенды ────────────────────────────────────────────────── */
  Object.freeze({
    name: 'SDELKA_MUTATE_LEDGER',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze([
      'packages/ledger/scripts/ledger-mutants.mjs',
      'packages/ledger/scripts/mutation.vitest.config.ts',
    ]),
  }),
  Object.freeze({
    name: 'SDELKA_MUTATE_INTAKE',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze([
      'packages/intake/scripts/intake-mutants.mjs',
      'packages/intake/scripts/mutation.vitest.config.ts',
    ]),
  }),
  Object.freeze({
    name: 'SDELKA_MUTATE_COMPLIANCE',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze([
      'packages/compliance/scripts/compliance-mutants.mjs',
      'packages/compliance/scripts/mutation.vitest.config.ts',
    ]),
  }),
  Object.freeze({
    name: 'SDELKA_MUTATE_GUARD',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze(['packages/e2e/vitest.config.ts']),
  }),
  Object.freeze({
    name: 'SDELKA_MUTATE_GUARD_TARGET',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze([
      'packages/e2e/scripts/guard-registry.mjs',
      'packages/e2e/scripts/guard-mutation.mjs',
    ]),
  }),

  /* ── Обход интерфейса ──────────────────────────────────────────────────── */
  Object.freeze({
    name: 'VERIFY_PORT',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: '3210',
    readBy: Object.freeze(['apps/web/scripts/verify-ui.mjs']),
  }),
  Object.freeze({
    name: 'CHROMIUM_PATH',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: '/opt/pw-browsers/chromium',
    readBy: Object.freeze(['apps/web/scripts/verify-ui.mjs']),
  }),
  Object.freeze({
    name: 'VERIFY_ONLY',
    scope: 'tooling',
    necessity: 'optional',
    secret: false,
    fallback: null,
    readBy: Object.freeze(['apps/web/scripts/verify-ui.mjs']),
  }),

  /* ── Вход в систему: apps/web ──────────────────────────────────────────── */
  Object.freeze({
    /**
     * Режим канала доставки одноразового кода: `development` | `production`.
     *
     * Обязательная и без умолчания намеренно. Умолчание здесь означало бы, что
     * забывший её развернуть получает **работающий с виду вход**, в котором код
     * печатается в журнал процесса, — то есть дыру, которой не видно ни по
     * экрану, ни по тестам. В боевом режиме процесс не поднимается, пока нет
     * боевого адаптера канала (`auth/src/delivery.ts`); сегодня его нет ни
     * одного, и это осознанное состояние.
     *
     * Тот же признак решает, ставится ли у куки сессии `Secure`: локальный
     * сервер работает по `http`, и кука с `Secure` там просто не ставится.
     */
    name: 'SDELKA_AUTH_MODE',
    scope: 'app',
    necessity: 'required',
    secret: false,
    fallback: null,
    readBy: Object.freeze([
      'apps/web/src/server/auth-config.ts',
      'apps/web/src/server/session-cookie.ts',
    ]),
  }),
  Object.freeze({
    /**
     * Ключ вывода одноразового кода.
     *
     * Кода нет ни в базе, ни в журнале — ни открытым, ни отпечатком: он
     * выводится из вызова этим ключом (`auth/src/code.ts`). Поэтому утечка
     * дампа кодов не даёт, а утечка ключа даёт все коды сразу — и ровно поэтому
     * ключ живёт только в окружении процесса.
     *
     * Тем же ключом считаются отпечатки устройства и сети для журнала входов, с
     * разделением назначений (`apps/web/src/server/origin.ts`). Разделять ли их
     * на две переменные — развилка владельца, `DECISIONS-REVIEW.md` §Z4.
     */
    name: 'SDELKA_AUTH_CODE_KEY',
    scope: 'app',
    necessity: 'required',
    secret: true,
    fallback: null,
    readBy: Object.freeze([
      'apps/web/src/server/auth-config.ts',
      'apps/web/src/server/origin.ts',
    ]),
  }),

  /* ── Резервная копия и проверенное восстановление: packages/backup ──────── */
  Object.freeze({
    name: 'SDELKA_BACKUP_DIR',
    scope: 'tooling',
    necessity: 'required',
    secret: false,
    fallback: null,
    readBy: Object.freeze(['packages/backup/src/env.ts']),
  }),
  Object.freeze({
    /**
     * База, в которую копия восстанавливается при проверке. Она ПЕРЕСОЗДАЁТСЯ,
     * поэтому переменная отдельная и обязательная: умолчание, подставляющее сюда
     * боевой адрес, однажды его и снесёт.
     */
    name: 'SDELKA_RESTORE_DATABASE_URL',
    scope: 'tooling',
    necessity: 'required',
    secret: true,
    fallback: null,
    readBy: Object.freeze(['packages/backup/src/env.ts']),
  }),
  Object.freeze({
    name: 'SDELKA_RESTORE_ADMIN_URL',
    scope: 'tooling',
    necessity: 'optional',
    secret: true,
    fallback: null,
    readBy: Object.freeze(['packages/backup/src/env.ts']),
  }),
]);

/** Имена в порядке перечня. Порядок стабильный: по нему сверяется `.env.example`. */
export function envVariableNames(
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): readonly string[] {
  return registry.map((variable) => variable.name);
}

/** Обязательные переменные области. Только они роняют старт. */
export function requiredVariables(
  scope: EnvScope,
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): readonly EnvVariable[] {
  return registry.filter(
    (variable) => variable.scope === scope && variable.necessity === 'required',
  );
}

/** Имена секретов. По нему проверяется, что ни одно значение не утекло в вывод. */
export function secretVariableNames(
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): readonly string[] {
  return registry.filter((variable) => variable.secret).map((variable) => variable.name);
}

export function findEnvVariable(
  name: string,
  registry: readonly EnvVariable[] = ENV_REGISTRY,
): EnvVariable {
  const found = registry.find((variable) => variable.name === name);
  if (found === undefined) {
    throw new ConfigError(ConfigErrorCode.registryUnknown, { variable: name });
  }
  return found;
}

/**
 * Перечень без дублей. Проверка отдельной функцией, а не только тестом: перечень
 * собирается вручную, и повтор имени с разными полями — не опечатка, а два
 * разных ответа на один вопрос «обязательна ли она».
 */
export function assertRegistryConsistent(registry: readonly EnvVariable[] = ENV_REGISTRY): void {
  const seen = new Set<string>();
  for (const variable of registry) {
    if (seen.has(variable.name)) {
      throw new ConfigError(ConfigErrorCode.registryDuplicate, { variable: variable.name });
    }
    seen.add(variable.name);
  }
}
