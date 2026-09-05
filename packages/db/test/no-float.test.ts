import { describe, expect, it } from 'vitest';
import { CODE_SQL, MIGRATIONS, stripComments } from './support/sql.ts';

/**
 * Красная линия №4: никаких сумм в плавающей точке.
 *
 * В TS её держит тип `Money` (`bigint` плюс код валюты). Границу процесса тип не
 * переживает, поэтому в схеме её держит этот тест плюс разборщики драйвера
 * (`src/pool.ts`): `numeric` и `int8` остаются строкой, `float4`/`float8`
 * вызывают ошибку разбора.
 */
describe('плавающей точки в схеме нет', () => {
  it('ни одного типа с плавающей точкой', () => {
    const forbidden = /\b(real|double precision|float4|float8|float\s*\()/giu;
    for (const migration of MIGRATIONS) {
      const found = [...stripComments(migration.sql).matchAll(forbidden)].map(
        (item) => item[0],
      );
      expect(found, migration.fileName).toEqual([]);
    }
  });

  it('ни одного numeric с дробной частью', () => {
    // `numeric(38, 0)` — целое произвольной величины, это допустимо и это
    // единственная форма денежной колонки. `numeric(12, 2)` — уже дробь, а
    // дробная сумма в минорных единицах не значит ничего.
    const scaled = [...CODE_SQL.matchAll(/numeric\s*\(\s*\d+\s*,\s*(\d+)\s*\)/gu)].filter(
      (item) => item[1] !== '0',
    );
    expect(scaled.map((item) => item[0])).toEqual([]);
  });

  it('денежные колонки таблиц объявлены numeric(38, 0)', () => {
    // Смотрим только на объявления колонок в `CREATE TABLE`: тип возврата
    // функции сводки объявлен `numeric` без разрядности намеренно — там уже
    // сумма, посчитанная из этих же колонок, и ограничивать её разрядность
    // значило бы уронить сложение вместо того, чтобы показать расхождение.
    const tableBodies = [...CODE_SQL.matchAll(/CREATE TABLE [\s\S]*?\n\);/gu)].map(
      (item) => item[0],
    );
    expect(tableBodies.length).toBeGreaterThan(5);
    const declarations = tableBodies.flatMap((body) =>
      [
        ...body.matchAll(/^ {2}([a-z_]*amount_minor|remaining_ms)\s+([a-z]+(?:\s*\([^)]*\))?)/gmu),
      ].map((item) => [item[1] ?? '', (item[2] ?? '').trim()] as const),
    );
    expect(declarations.length).toBeGreaterThan(0);
    for (const [column, type] of declarations) {
      if (column === 'remaining_ms') {
        // Длительность — не деньги, но и она целая: `DurationMs` в домене
        // строго положительное целое число миллисекунд.
        expect(type.startsWith('bigint'), `${column}: ${type}`).toBe(true);
        continue;
      }
      expect(type.startsWith('numeric(38, 0)'), `${column}: ${type}`).toBe(true);
    }
  });

  it('денежные колонки и курсы, добавленные позже, объявлены так же', () => {
    // Проверка выше смотрит **только внутрь `CREATE TABLE`**, и колонка,
    // заведённая `ALTER TABLE … ADD COLUMN`, мимо неё проходит целиком. То есть
    // правило действовало на первую редакцию таблицы и переставало действовать
    // на все следующие — а объявления записи журнала (`0021`) приезжают именно
    // так.
    //
    // Курс сюда входит наравне с суммой: красная линия №4 говорит о суммах, но
    // курс — это то, из чего сумма считается, и `2,6686875` в double не равен
    // себе уже после трёх операций. В TS это `Rational` из двух `bigint`.
    const added = [
      ...CODE_SQL.matchAll(
        /ADD COLUMN ([a-z_]*(?:amount_minor|numerator|denominator))\s+([a-z]+(?:\s*\([^)]*\))?)/gu,
      ),
    ].map((item) => [item[1] ?? '', (item[2] ?? '').trim()] as const);
    expect(added.length).toBeGreaterThan(0);
    for (const [column, type] of added) {
      expect(type.startsWith('numeric(38, 0)'), `${column}: ${type}`).toBe(true);
    }
  });
});

describe('пользовательского текста в схеме нет', () => {
  it('сообщения RAISE — технические ключи без пробелов и кириллицы', () => {
    const messages = [...CODE_SQL.matchAll(/RAISE EXCEPTION '([^']*)'/gu)].map(
      (item) => item[1] ?? '',
    );
    for (const message of messages) {
      expect(message, message).not.toMatch(/\s/u);
      expect(message, message).not.toMatch(/[Ѐ-ӿ]/u);
    }
  });

  it('кириллица встречается только в комментариях', () => {
    // Комментарии на русском — это объяснение решения, а не вывод. Всё
    // остальное, что видит клиент, живёт в словарях локализации.
    for (const migration of MIGRATIONS) {
      const code = stripComments(migration.sql).replace(
        /COMMENT ON [\s\S]*?';\n/gu,
        '',
      );
      const cyrillic = [...code.matchAll(/[Ѐ-ӿ]+/gu)].map((item) => item[0]);
      expect(cyrillic, migration.fileName).toEqual([]);
    }
  });
});
