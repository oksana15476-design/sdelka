import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../src/errors.ts';
import {
  CHECKSUMS_NAME,
  checksumDrift,
  checksumOf,
  loadMigrations,
  loadVerifiedMigrations,
  renderChecksums,
} from '../src/migrations.ts';

/**
 * Каталог миграций против слепка `CHECKSUMS` — **до подключения к базе**.
 *
 * Прежняя сверка была только одна: контрольная сумма применённой миграции
 * против записи в базе. На накаченной базе она работает, на **чистой** — не
 * работает вовсе: применять нечего, сверять не с чем, и подменённый файл уехал
 * бы в схему молча. Ровно так база и расходится с кодом незаметно — не при
 * правке боевой схемы, а при первом развёртывании из подменённого дерева.
 *
 * Набор офлайновый намеренно: проверка, срабатывающая только у того, у кого
 * поднят кластер, — это проверка, которой нет у разворачивающего.
 */
const created: string[] = [];

function fixture(files: Readonly<Record<string, string>>, checksums?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdelka-migrations-'));
  created.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, 'utf8');
  }
  writeFileSync(
    join(dir, CHECKSUMS_NAME),
    checksums ?? renderChecksums(loadMigrations(dir)),
    'utf8',
  );
  return dir;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const FIRST = '-- 0001\nSELECT 1;\n';
const SECOND = '-- 0002\nSELECT 2;\n';

function driftOf(dir: string): DbError {
  try {
    loadVerifiedMigrations(dir);
  } catch (error) {
    if (error instanceof DbError) return error;
    throw error;
  }
  throw new Error('ожидался отказ, а накат принял каталог');
}

describe('каталог миграций сверяется со слепком CHECKSUMS', () => {
  it('сошёлся — миграции читаются по порядку номеров', () => {
    const dir = fixture({ '0001_one.sql': FIRST, '0002_two.sql': SECOND });
    expect(loadVerifiedMigrations(dir).map((item) => item.version)).toEqual(['0001', '0002']);
  });

  it('файл изменён после фиксации — отказ, а не тихое применение', () => {
    // Тот самый случай: миграцию поправили вместо того, чтобы завести новую.
    const dir = fixture({ '0001_one.sql': FIRST, '0002_two.sql': SECOND });
    writeFileSync(join(dir, '0002_two.sql'), `${SECOND}SELECT 3;\n`, 'utf8');
    const error = driftOf(dir);
    expect(error.code).toBe(DbErrorCode.migrationChecksumDrift);
    expect(error.details.kind).toBe('changed');
    expect(error.details.fileName).toBe('0002_two.sql');
  });

  it('файла нет в слепке — отказ: `db:generate` не запускали', () => {
    const dir = fixture({ '0001_one.sql': FIRST });
    writeFileSync(join(dir, '0002_two.sql'), SECOND, 'utf8');
    const error = driftOf(dir);
    expect(error.details.kind).toBe('unlisted');
    expect(error.details.fileName).toBe('0002_two.sql');
  });

  it('в слепке есть, файла нет — отказ: удалённая миграция иначе молчалива', () => {
    // Односторонняя сверка («каждый файл найден в слепке») это пропускает:
    // файла нет, сверять нечего, накат применяет на шаг меньше и молчит.
    const dir = fixture({ '0001_one.sql': FIRST, '0002_two.sql': SECOND });
    rmSync(join(dir, '0002_two.sql'));
    const error = driftOf(dir);
    expect(error.details.kind).toBe('orphaned');
    expect(error.details.fileName).toBe('0002_two.sql');
  });

  it('расхождений несколько — перечислены все, а не первое', () => {
    const dir = fixture({ '0001_one.sql': FIRST, '0002_two.sql': SECOND });
    writeFileSync(join(dir, '0001_one.sql'), `${FIRST}SELECT 9;\n`, 'utf8');
    rmSync(join(dir, '0002_two.sql'));
    expect(driftOf(dir).details.files).toBe('0001_one.sql:changed,0002_two.sql:orphaned');
  });

  it('слепка нет вовсе — отказ, а не накат вслепую', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdelka-migrations-'));
    created.push(dir);
    writeFileSync(join(dir, '0001_one.sql'), FIRST, 'utf8');
    expect(() => loadVerifiedMigrations(dir)).toThrow();
  });

  it('каталог этого дерева сходится со своим слепком', () => {
    // Регрессия на самом репозитории: накат обязан пройти сверку без правок.
    expect(loadVerifiedMigrations().length).toBeGreaterThan(0);
  });
});

describe('разбор расхождений — чистая функция', () => {
  const one = Object.freeze({
    version: '0001',
    fileName: '0001_one.sql',
    sql: FIRST,
    checksum: checksumOf(FIRST),
  });

  it('пустой слепок даёт unlisted на каждую миграцию', () => {
    expect(checksumDrift([one], new Map())).toEqual([{ fileName: '0001_one.sql', kind: 'unlisted' }]);
  });

  it('совпадение не даёт расхождений', () => {
    expect(checksumDrift([one], new Map([['0001_one.sql', one.checksum]]))).toEqual([]);
  });
});
