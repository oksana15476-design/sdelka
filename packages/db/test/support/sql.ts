import { loadMigrations } from '../../src/migrations.ts';

/**
 * Разбор миграций как текста.
 *
 * Тесты дрейфа читают SQL глазами, а не через базу: без Postgres они обязаны
 * работать, потому что иначе рассыпание перечня между TS и SQL замечал бы
 * только тот, у кого поднят кластер.
 */
export const MIGRATIONS = loadMigrations();

export const ALL_SQL = MIGRATIONS.map((item) => item.sql).join('\n');

/**
 * Текст без комментариев: строчных `--` и блочных. Проверки вида «нет
 * плавающей точки» и «нет кириллицы в сообщении» обязаны смотреть на код, а не
 * на объяснение к нему — в комментариях кириллица как раз есть и должна быть.
 */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\n]*/gu, '');
}

export const CODE_SQL = stripComments(ALL_SQL);

/** Перечни: `CREATE TYPE sdelka.<имя> AS ENUM (...)` → значения по порядку. */
export function parseEnums(sql: string): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const pattern = /CREATE TYPE sdelka\.([a-z_]+) AS ENUM \(([^)]*)\)/gu;
  let match = pattern.exec(sql);
  while (match !== null) {
    const name = match[1];
    const body = match[2];
    if (name !== undefined && body !== undefined) {
      const values = [...body.matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
      result.set(name, Object.freeze(values));
    }
    match = pattern.exec(sql);
  }
  return result;
}

/** Все ключи, поднимаемые `RAISE EXCEPTION '<ключ>'`. */
export function raisedCodes(sql: string): readonly string[] {
  return [...sql.matchAll(/RAISE EXCEPTION '([^']*)'/gu)].map((item) => item[1] ?? '');
}

/** Строки предиката частичного индекса: `WHERE status IN ('a', 'b')`. */
export function partialIndexStatuses(sql: string, indexName: string): readonly string[] {
  const pattern = new RegExp(
    `CREATE UNIQUE INDEX ${indexName}[\\s\\S]*?WHERE status IN \\(([^)]*)\\)`,
    'u',
  );
  const match = pattern.exec(sql);
  const body = match?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
}

/** Значения из именованного ограничения `CHECK (... IN ('a', 'b'))`. */
export function constraintStatuses(sql: string, constraintName: string): readonly string[] {
  const pattern = new RegExp(`CONSTRAINT ${constraintName} CHECK \\(([\\s\\S]*?)\\n  \\)`, 'u');
  const match = pattern.exec(sql);
  const body = match?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
}
