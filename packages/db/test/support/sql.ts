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

/**
 * Перечни: `CREATE TYPE sdelka.<имя> AS ENUM (...)` плюс последующие
 * `ALTER TYPE sdelka.<имя> ADD VALUE '<метка>'` — значения по порядку.
 *
 * Дописанные метки обязаны учитываться здесь, иначе тест дрейфа читает только
 * первую редакцию перечня: значение добавлено в TS и в миграцию, а сверка
 * видит старый список и падает на верном коде. Ошибка в сторону ложной тревоги
 * тоже ошибка — на второй раз такой тест начинают «чинить» ослаблением.
 */
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
  const added = /ALTER TYPE sdelka\.([a-z_]+) ADD VALUE ([^;]*);/gu;
  let alter = added.exec(sql);
  while (alter !== null) {
    const name = alter[1] ?? '';
    const tail = alter[2] ?? '';
    if (/\b(BEFORE|AFTER)\b/u.test(tail)) {
      // Вставку метки в середину перечня разборщик не моделирует. Молча вернуть
      // неверный порядок хуже, чем упасть: порядок меток виден в `ORDER BY`, и
      // разошедшаяся сортировка отчёта дежурному ничем себя не выдаёт.
      throw new Error(`db.enum.position_not_modelled:${name}`);
    }
    const label = /'([^']*)'/u.exec(tail)?.[1];
    const previous = result.get(name);
    if (label !== undefined && previous !== undefined) {
      result.set(name, Object.freeze([...previous, label]));
    }
    alter = added.exec(sql);
  }
  return result;
}

/** Все ключи, поднимаемые `RAISE EXCEPTION '<ключ>'`. */
export function raisedCodes(sql: string): readonly string[] {
  return [...sql.matchAll(/RAISE EXCEPTION '([^']*)'/gu)].map((item) => item[1] ?? '');
}

/**
 * Строки предиката частичного индекса: `WHERE status IN ('a', 'b')`.
 *
 * Уникальность индекса в разборе необязательна. Частичный индекс несёт перечень
 * статусов и тогда, когда он не уникален: `withdrawal_stalled` (`0022`) — список
 * «у кого есть возраст», и его перечень обязан сверяться с доменом ровно так же,
 * как перечень уникального `withdrawal_one_active_per_party`. Требовать здесь
 * `UNIQUE` значило бы возвращать пустой список на верном индексе — то есть
 * сверять, ничего не сверив.
 */
export function partialIndexStatuses(sql: string, indexName: string): readonly string[] {
  const pattern = new RegExp(
    `CREATE (?:UNIQUE )?INDEX ${indexName}[\\s\\S]*?WHERE status IN \\(([^)]*)\\)`,
    'u',
  );
  const match = pattern.exec(sql);
  const body = match?.[1];
  if (body === undefined) return [];
  return [...body.matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
}

/**
 * Тело выражения в скобках, начиная с позиции открывающей скобки.
 *
 * Считаем скобки, а не обрываем регуляркой по отступу: ограничение, заведённое
 * `ALTER TABLE ... ADD CONSTRAINT`, отформатировано иначе, чем то же
 * ограничение внутри `CREATE TABLE`, и разбор по виду отступа тихо возвращал
 * бы пустой список — то есть сверка проходила бы, ничего не сверив.
 */
function balancedBody(sql: string, open: number): string {
  let depth = 0;
  for (let index = open; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, index);
    }
  }
  throw new Error('db.sql.unbalanced_parenthesis');
}

function quoted(text: string): readonly string[] {
  return [...text.matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
}

/**
 * Строковые значения из именованного ограничения `CHECK (... IN ('a', 'b'))`.
 *
 * Берётся **последнее** объявление с таким именем: ограничение, заменённое
 * поздней миграцией (`DROP CONSTRAINT` плюс `ADD CONSTRAINT`), обязано
 * сверяться в действующей редакции, а не в первой.
 */
export function constraintValues(sql: string, constraintName: string): readonly string[] {
  const anchor = `CONSTRAINT ${constraintName} CHECK `;
  const at = sql.lastIndexOf(anchor);
  if (at === -1) return [];
  return quoted(balancedBody(sql, sql.indexOf('(', at + anchor.length)));
}

/** Прежнее имя того же разбора: перечень статусов в именованном ограничении. */
export const constraintStatuses = constraintValues;

/**
 * Строковые значения в теле представления — `CREATE VIEW ... ;`.
 *
 * Нужно там, где список живёт не в ограничении, а в предикате представления:
 * коды стоп-крана в `v_should_stop_accepting_deals` перечислены поимённо, и
 * второй такой же список поимённо лежит в TS.
 */
export function viewValues(sql: string, viewName: string): readonly string[] {
  const anchor = `CREATE VIEW sdelka.${viewName} AS`;
  const at = sql.indexOf(anchor);
  if (at === -1) return [];
  const end = sql.indexOf(';', at);
  return quoted(sql.slice(at, end === -1 ? sql.length : end));
}
