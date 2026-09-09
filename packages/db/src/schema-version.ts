import { DbError, DbErrorCode } from './errors.ts';
import { type Migration, MIGRATIONS_DIR, loadVerifiedMigrations } from './migrations.ts';
import type { Pool, PoolClient } from './pool.ts';
import { MIGRATION_TABLE } from './roles.ts';

/**
 * Ворота старта приложения: **схема накачена ровно до той версии, которую знает
 * этот код, — иначе процесс не поднимается**.
 *
 * Порядок при развёртывании один: база готова → накат → приложение. Ворота
 * стоят на третьем шаге и защищают от двух исходов, каждый из которых иначе
 * молчалив:
 *
 * 1. **База отстаёт.** Накат забыли или он упал, а приложение подняли. Оно
 *    встанет, ответит на запросы и упадёт позже — на первом обращении к
 *    колонке, которой нет, где-нибудь в середине денежной операции. Отказ на
 *    старте видит один человек за минуту, отказ в середине операции — клиент;
 * 2. **База впереди.** Накат прошёл, приложение откатили на предыдущую сборку.
 *    Старый код не знает, что изменила чужая миграция, и «как-нибудь работать»
 *    в этом состоянии — это гадание над деньгами.
 *
 * Ворота **ничего не чинят**: они не мигрируют и не подстраиваются. Приложение,
 * применяющее миграции на старте, — это накат от роли приложения (права шире
 * нужных) и гонка на нескольких репликах. Накат — отдельный шаг, отдельная
 * роль, отдельная команда (`pnpm --filter @sdelka/db migrate`).
 *
 * Прав на чтение хватает роли приложения: `SELECT` на `sdelka.schema_migration`
 * выдан ещё `0008` (`GRANT SELECT ON ALL TABLES IN SCHEMA sdelka`). Расширять
 * права ради ворот не понадобилось, и расширять их нельзя: инвариант 21.
 */
export interface AppliedMigration {
  readonly version: string;
  readonly checksum: string;
}

/**
 * Расхождение схемы с кодом. Разбор по роду, а не «true/false»: чинятся они
 * по-разному, и дежурному нужен род, а не факт.
 */
export type SchemaDivergence =
  | { readonly kind: 'current'; readonly version: string }
  | { readonly kind: 'uninitialized' }
  | { readonly kind: 'behind'; readonly versions: readonly string[] }
  | { readonly kind: 'ahead'; readonly versions: readonly string[] }
  | { readonly kind: 'changed'; readonly versions: readonly string[] };

/** Ожидаемая версия схемы — номер последней миграции каталога. */
export function expectedVersion(migrations: readonly Migration[]): string {
  const last = migrations.at(-1);
  if (last === undefined) throw new Error('db.migration.empty_directory');
  return last.version;
}

/**
 * Сверка ожидаемого с применённым — **чистая функция**, проверяемая без базы.
 *
 * Порядок разбора не косметический. Расхождения сравниваются по цене ошибки:
 *
 * 1. `changed` — применённая версия имеет другую контрольную сумму. Это
 *    единственный род, при котором номера сходятся, а схема — нет: снаружи
 *    такая база выглядит накаченной. Самое опасное, значит первым;
 * 2. `ahead` — в базе есть версии, которых нет в коде. Дальше идти нельзя: чем
 *    отличается чужая схема, этот код не знает;
 * 3. `behind` — не хватает версий. Чинится накатом, и это самый обычный случай.
 */
export function compareSchema(
  expected: readonly Migration[],
  applied: readonly AppliedMigration[] | null,
): SchemaDivergence {
  if (applied === null) return Object.freeze({ kind: 'uninitialized' as const });
  const known = new Map(applied.map((item) => [item.version, item.checksum]));
  const changed: string[] = [];
  const behind: string[] = [];
  for (const migration of expected) {
    const checksum = known.get(migration.version);
    if (checksum === undefined) {
      behind.push(migration.version);
    } else if (checksum !== migration.checksum) {
      changed.push(migration.version);
    }
  }
  if (changed.length > 0) {
    return Object.freeze({ kind: 'changed' as const, versions: Object.freeze(changed) });
  }
  const files = new Set(expected.map((item) => item.version));
  const ahead = [...known.keys()].filter((version) => !files.has(version)).sort();
  if (ahead.length > 0) {
    return Object.freeze({ kind: 'ahead' as const, versions: Object.freeze(ahead) });
  }
  if (behind.length > 0) {
    return Object.freeze({ kind: 'behind' as const, versions: Object.freeze(behind) });
  }
  return Object.freeze({ kind: 'current' as const, version: expectedVersion(expected) });
}

/** Ключ отказа для рода расхождения. `current` отказа не имеет. */
const DIVERGENCE_CODE = Object.freeze({
  uninitialized: DbErrorCode.schemaNotInitialized,
  behind: DbErrorCode.schemaBehind,
  ahead: DbErrorCode.schemaAhead,
  changed: DbErrorCode.schemaChecksumMismatch,
});

/** Минимум, который нужен воротам от соединения: один `SELECT`. */
export interface SchemaReader {
  query<T>(text: string): Promise<{ readonly rows: T[] }>;
}

/**
 * Применённые миграции, либо `null`, если таблицы учёта нет вовсе.
 *
 * `to_regclass` вместо `catch` на «relation does not exist» намеренно: ошибка
 * внутри транзакции обрывает её целиком, и вызывающий, спросивший версию схемы
 * первым делом, получил бы вместо ответа мёртвую транзакцию.
 */
export async function readAppliedMigrations(
  client: SchemaReader,
): Promise<readonly AppliedMigration[] | null> {
  const present = await client.query<{ readonly oid: string | null }>(
    `SELECT to_regclass('${MIGRATION_TABLE}')::text AS oid`,
  );
  if (present.rows[0]?.oid == null) return null;
  const rows = await client.query<AppliedMigration>(
    `SELECT version, checksum FROM ${MIGRATION_TABLE} ORDER BY version`,
  );
  return Object.freeze(rows.rows.map((row) => Object.freeze({ ...row })));
}

/** Состояние схемы по живому соединению. Ничего не меняет и не блокирует. */
export async function schemaState(
  client: SchemaReader,
  dir: string = MIGRATIONS_DIR,
): Promise<SchemaDivergence> {
  return compareSchema(loadVerifiedMigrations(dir), await readAppliedMigrations(client));
}

/**
 * Ворота старта: расхождение — отказ с техническим ключом, совпадение —
 * версия схемы.
 *
 * В `details` только номера версий: строки подключения, хостов и паролей здесь
 * нет и быть не может (красная линия №12).
 */
export async function assertSchemaCurrent(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string> {
  const client: PoolClient = await pool.connect();
  try {
    const state = await schemaState(client, dir);
    if (state.kind === 'current') return state.version;
    throw new DbError(DIVERGENCE_CODE[state.kind], {
      expected: expectedVersion(loadVerifiedMigrations(dir)),
      versions: state.kind === 'uninitialized' ? '' : state.versions.join(','),
    });
  } finally {
    client.release();
  }
}
