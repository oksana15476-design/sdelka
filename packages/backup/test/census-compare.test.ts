import { InvariantCode } from '@sdelka/ledger';
import { describe, expect, it } from 'vitest';
import { CENSUS_FORMAT_VERSION } from '../src/census.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';
import { type Finding, codeOf, compareCensus, healthFindings } from '../src/verify.ts';
import { census, shuffled } from './support/fixtures.ts';

/**
 * Сверка переписи — сердце проверки восстановления, и проверяется она без базы.
 *
 * Утверждение набора одно: **сверка умеет провалиться, и проваливается
 * поимённо**. «Что-то не сошлось» дежурному бесполезно — чинятся «разошлась
 * одна таблица» и «разошлось всё» по-разному, а различает их только состав
 * расхождений.
 */
function codes(findings: readonly Finding[]): readonly string[] {
  return findings.map((item) => item.code);
}

function only(findings: readonly Finding[]): Finding {
  expect(findings).toHaveLength(1);
  return findings[0] as Finding;
}

describe('перепись сходится сама с собой', () => {
  it('одинаковые переписи расхождений не дают', () => {
    expect(compareCensus(census(), census())).toEqual([]);
  });

  it('порядок строк не имеет значения: сортировка зависит от локали базы', () => {
    // Восстановленная база не обязана иметь тот же `LC_COLLATE`, что источник.
    // Сверка, чувствительная к порядку, объявила бы целую копию порванной.
    expect(compareCensus(census(), shuffled(census()))).toEqual([]);
  });

  it('версия формата переписи — часть слепка, а не подразумевается', () => {
    expect(census().formatVersion).toBe(CENSUS_FORMAT_VERSION);
  });
});

describe('схема', () => {
  it('другая версия схемы названа обеими сторонами', () => {
    const found = only(compareCensus(census(), census({ schemaVersion: '0022' })));
    expect(found.code).toBe(BackupErrorCode.schemaVersionMismatch);
    expect(found.details).toEqual({ expected: '0023', actual: '0022' });
  });

  it('та же версия с другой контрольной суммой миграции — тоже расхождение схемы', () => {
    // Самый опасный род: номера сходятся, схема — нет. Снаружи такая база
    // выглядит накаченной.
    const actual = census({
      migrations: [
        { version: '0001', checksum: '1'.repeat(64) },
        { version: '0023', checksum: '9'.repeat(64) },
      ],
    });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.schemaVersionMismatch);
    expect(found.details.reason).toBe('migration_set');
  });
});

describe('таблицы', () => {
  it('таблица не доехала — названа поимённо', () => {
    const actual = census({ tables: census().tables.filter((item) => item.table !== 'ledger_entry') });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.tableSetMismatch);
    expect(found.details).toEqual({ table: 'ledger_entry', side: 'missing' });
  });

  it('лишняя таблица — тоже расхождение: копия снята не с той базы', () => {
    const actual = census({ tables: [...census().tables, { table: 'temp_import', rows: '9' }] });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.tableSetMismatch);
    expect(found.details).toEqual({ table: 'temp_import', side: 'extra' });
  });

  it('потерянная строка таблицы — отдельный отказ с обоими количествами', () => {
    const actual = census({
      tables: census().tables.map((item) =>
        item.table === 'ledger_posting' ? { table: item.table, rows: '3' } : item,
      ),
    });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.tableRowsMismatch);
    expect(found.details).toEqual({ table: 'ledger_posting', expected: '4', actual: '3' });
  });

  it('пустая восстановленная база — это перечень расхождений, а не тишина', () => {
    const empty = census({
      tables: [],
      chains: [],
      postingSums: [],
      coverage: [],
      auditRecords: '0',
      journalEntries: '0',
    });
    const found = compareCensus(census(), empty);
    expect(codes(found).filter((code) => code === BackupErrorCode.tableSetMismatch)).toHaveLength(3);
    expect(codes(found)).toContain(BackupErrorCode.chainSetMismatch);
    expect(codes(found)).toContain(BackupErrorCode.coverageMismatch);
  });
});

describe('цепочки вечного журнала', () => {
  it('цепочка не доехала целиком', () => {
    const actual = census({ chains: census().chains.filter((item) => item.chainId !== 'chain-b') });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.chainSetMismatch);
    expect(found.details).toEqual({ chainId: 'chain-b', side: 'missing' });
  });

  it('лишняя цепочка', () => {
    const actual = census({
      chains: [...census().chains, { chainId: 'chain-c', records: '1', head: 'c'.repeat(64) }],
    });
    expect(only(compareCensus(census(), actual)).details).toEqual({
      chainId: 'chain-c',
      side: 'extra',
    });
  });

  it('потерянное звено: длина и голова расходятся по отдельности', () => {
    const actual = census({
      chains: [
        { chainId: 'chain-a', records: '1', head: 'd'.repeat(64) },
        { chainId: 'chain-b', records: '1', head: 'b'.repeat(64) },
      ],
    });
    const found = compareCensus(census(), actual);
    expect(codes(found)).toEqual([
      BackupErrorCode.chainLengthMismatch,
      BackupErrorCode.chainHeadMismatch,
    ]);
    expect(found[0]?.details).toEqual({ chainId: 'chain-a', expected: '2', actual: '1' });
  });

  it('подменённое звено: длина та же, голова другая', () => {
    // Правка в середине цепочки не меняет числа записей — её ловит только хеш
    // головы, покрывающий всю историю до генезиса.
    const actual = census({
      chains: [
        { chainId: 'chain-a', records: '2', head: `deadbeef${'0'.repeat(56)}` },
        ...census().chains.slice(1),
      ],
    });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.chainHeadMismatch);
    // Голова печатается обрезанной: восьми знаков хватает, чтобы отличить одну
    // от другой в отчёте.
    expect(found.details).toEqual({ chainId: 'chain-a', expected: 'aaaaaaaa', actual: 'deadbeef' });
  });
});

describe('суммы проводок и покрытие', () => {
  it('уехавшая сумма ловится при том же числе строк', () => {
    const actual = census({
      postingSums: [
        { currency: 'GEL', sumMinor: '-1' },
        { currency: 'USD', sumMinor: '0' },
      ],
    });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.postingSumMismatch);
    expect(found.details).toEqual({ currency: 'GEL', expected: '0', actual: '-1' });
  });

  it('валюта, пропавшая из восстановленного, сравнивается с нулём, а не пропускается', () => {
    const actual = census({ postingSums: [{ currency: 'GEL', sumMinor: '0' }] });
    // У обеих валют ожидался ноль, поэтому расхождения нет — и это правильно:
    // пропажу самих строк ловит сверка таблиц.
    expect(compareCensus(census(), actual)).toEqual([]);
    const nonZero = census({ postingSums: [{ currency: 'USD', sumMinor: '5' }] });
    expect(only(compareCensus(census(), nonZero)).details).toEqual({
      currency: 'USD',
      expected: '0',
      actual: '5',
    });
  });

  it('уехавшее покрытие названо обеими сторонами', () => {
    const actual = census({
      coverage: [
        {
          currency: 'GEL',
          custodyMinor: '19999999',
          obligationsMinor: '20000000',
          covered: false,
        },
      ],
    });
    const found = only(compareCensus(census(), actual));
    expect(found.code).toBe(BackupErrorCode.coverageMismatch);
    expect(found.details).toEqual({
      currency: 'GEL',
      expectedCustody: '20000000',
      expectedObligations: '20000000',
      actualCustody: '19999999',
      actualObligations: '20000000',
    });
  });
});

describe('здоровье восстановленного', () => {
  it('целая копия признаков нездоровья не даёт', () => {
    expect(healthFindings(census(), { allowEmpty: false })).toEqual([]);
  });

  it('оба журнала пусты — это отказ, а не успех', () => {
    const empty = census({ auditRecords: '0', journalEntries: '0' });
    const found = only(healthFindings(empty, { allowEmpty: false }));
    expect(found.code).toBe(BackupErrorCode.nothingChecked);
    expect(found.details).toEqual({ auditRecords: '0', journalEntries: '0' });
  });

  it('пустоту разрешает только явный флаг', () => {
    const empty = census({ auditRecords: '0', journalEntries: '0' });
    expect(healthFindings(empty, { allowEmpty: true })).toEqual([]);
  });

  it('пустой журнал учёта при непустом аудите отказом не является', () => {
    expect(healthFindings(census({ journalEntries: '0' }), { allowEmpty: false })).toEqual([]);
  });

  it('несведённая сумма проводок поднимается ключом инварианта, а не своим', () => {
    const found = only(
      healthFindings(census({ postingSums: [{ currency: 'GEL', sumMinor: '1' }] }), {
        allowEmpty: false,
      }),
    );
    // Правило одно и в бою, и в копии — значит, и ключ один: искать их
    // дежурному придётся вместе.
    expect(found.code).toBe(InvariantCode.entryUnbalanced);
    expect(found.details).toEqual({ currency: 'GEL', subject: 'journal', amountMinor: '1' });
  });

  it('покрытие ниже единицы поднимается ключом инварианта покрытия', () => {
    const found = only(
      healthFindings(
        census({
          coverage: [
            {
              currency: 'GEL',
              custodyMinor: '1',
              obligationsMinor: '2',
              covered: false,
            },
          ],
        }),
        { allowEmpty: false },
      ),
    );
    expect(found.code).toBe(InvariantCode.coverageBelowOne);
    expect(found.details).toEqual({
      currency: 'GEL',
      subject: 'portfolio',
      custody: '1',
      obligations: '2',
    });
  });
});

describe('код отказа из чужой ошибки', () => {
  it('у ошибки пакета берётся её ключ', () => {
    expect(codeOf(new BackupError(BackupErrorCode.digestMismatch))).toBe(
      'backup.digest.mismatch',
    );
  });

  it('у ошибки без ключа берётся имя, а не выдумывается ключ', () => {
    expect(codeOf(new TypeError('boom'))).toBe('TypeError');
  });

  it('у не-ошибки ключ назван неизвестным', () => {
    expect(codeOf('строка')).toBe('unknown');
  });
});
