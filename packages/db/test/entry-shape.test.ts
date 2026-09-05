import { describe, expect, it } from 'vitest';
import {
  ACCRUES_COLUMNS,
  CONVERTS_COLUMNS,
  CORE_COLUMNS,
  ENTRY_MAPS,
  FUNDS_COLUMNS,
  MIRRORED_ENTRY_COLUMNS,
  NON_DOMAIN_COLUMNS,
  SETTLES_COLUMNS,
  derivedReferences,
  storedColumns,
} from '../src/store/entry-shape.ts';
import { ENTRY_COLUMN_NAMES } from '../src/store/journal.ts';

/**
 * Дрейф формы записи журнала — половина без базы.
 *
 * Полная сверка состоит из трёх частей, и каждая ловит свой способ разойтись:
 *
 * 1. **поле значения без места** — ловит компилятор: карты в `entry-shape.ts`
 *    размечены над типами учёта (`ColumnsOf<FxExecution>` и остальные), поэтому
 *    новое поле объявления не даст собрать карту вовсе;
 * 2. **место без записи и чтения** — ловит этот файл: список колонок, которым
 *    пользуются `INSERT` и `SELECT` (`ENTRY_COLUMN_NAMES`), обязан совпасть с
 *    картой поле в поле. Колонка, размеченная в карте и забытая в запросе,
 *    равнялась бы сама себе всегда;
 * 3. **колонка в таблице, о которой не знает код** — ловит
 *    `test/int/entry-columns.int.test.ts` сверкой с живой схемой.
 *
 * Без базы работают первые две: расхождение TS и SQL обязано быть заметно и
 * тому, у кого кластер не поднят.
 */
describe('форма записи журнала: карта и запросы', () => {
  const mapped = ENTRY_MAPS.flatMap((map) => storedColumns(map));

  it('карта вообще не пуста', () => {
    expect(mapped.length).toBeGreaterThan(20);
  });

  it('колонка в карте названа один раз', () => {
    // Две ветки, ведущие в одну колонку, — это два факта в одном месте:
    // второй затирает первый, и заметить это можно только по значению.
    expect([...new Set(mapped)].sort()).toEqual([...mapped].sort());
  });

  it('запросы пишут и читают ровно то, что размечено картой', () => {
    expect([...ENTRY_COLUMN_NAMES].sort()).toEqual([...mapped].sort());
  });

  it('порядок колонок в запросах без повторов', () => {
    // `INSERT` собирается из этого же списка: повтор имени сдвинул бы все
    // подстановки после него, а типы колонок при этом совпали бы.
    expect(new Set(ENTRY_COLUMN_NAMES).size).toBe(ENTRY_COLUMN_NAMES.length);
  });

  it('выведенные поля ссылаются на колонки, которые действительно есть', () => {
    // Пометка «выводится из» — не отписка: колонка, на которую она ссылается,
    // обязана существовать, иначе поле не выводится ниоткуда.
    const stored = new Set(mapped);
    const dangling = ENTRY_MAPS.flatMap((map) => derivedReferences(map)).filter(
      (column) => !stored.has(column),
    );
    expect(dangling).toEqual([]);
  });

  it('пара валют курса не хранится второй копией', () => {
    // Три курса и сам набор несут `base`/`quote` — шесть полей, и все шесть
    // выводятся из валют ног. Вторая копия кода валюты разошлась бы с первой
    // молча; проверка держит именно это решение, а не просто «поля размечены».
    expect(derivedReferences(CONVERTS_COLUMNS)).toEqual([
      'converts_source_currency',
      'converts_target_currency',
      'converts_source_currency',
      'converts_target_currency',
      'converts_source_currency',
      'converts_target_currency',
      'converts_source_currency',
      'converts_target_currency',
    ]);
    expect(storedColumns(CONVERTS_COLUMNS)).not.toContain('converts_rates_base');
  });

  it('каждое объявление размечено целиком', () => {
    // Числа проверяются поимённо, а не «больше нуля»: объявление, у которого
    // разметили половину полей, прошло бы слабую проверку целиком.
    expect(storedColumns(CORE_COLUMNS)).toHaveLength(5);
    expect(storedColumns(SETTLES_COLUMNS)).toHaveLength(7);
    expect(storedColumns(CONVERTS_COLUMNS)).toHaveLength(12);
    expect(storedColumns(ACCRUES_COLUMNS)).toHaveLength(5);
    expect(storedColumns(FUNDS_COLUMNS)).toHaveLength(4);
  });

  it('колонки без доменного источника перечислены с причиной', () => {
    for (const [column, reason] of NON_DOMAIN_COLUMNS) {
      expect(column, column).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(reason.length, column).toBeGreaterThan(10);
    }
    expect(MIRRORED_ENTRY_COLUMNS).toContain('seq');
  });
});
