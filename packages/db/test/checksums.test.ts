import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SNAPSHOT, renderSnapshot } from '../src/generate.ts';
import { CHECKSUMS_FILE, parseChecksums } from '../src/migrations.ts';
import { MIGRATIONS } from './support/sql.ts';

/**
 * Применённая миграция не правится — заводится новая.
 *
 * Правка уже применённого файла расходится с тем, что стоит на проде, и
 * расхождение это молчаливое: локально всё сходится, потому что локально базу
 * пересоздают. Раннер отвергает такую правку по контрольной сумме
 * (`db.migration.checksum_mismatch`), но узнать о ней надо до подключения к
 * базе — здесь.
 */
describe('контрольные суммы миграций', () => {
  const stored = parseChecksums(readFileSync(CHECKSUMS_FILE, 'utf8'));

  it('перечислены ровно те же файлы', () => {
    expect([...stored.keys()].sort()).toEqual(MIGRATIONS.map((item) => item.fileName).sort());
  });

  for (const migration of MIGRATIONS) {
    it(`${migration.fileName} не менялась после фиксации`, () => {
      expect(stored.get(migration.fileName)).toBe(migration.checksum);
    });
  }

  it('снимок схемы собран из текущих миграций', () => {
    // `pnpm db:generate` пересобирает снимок. Разошедшийся снимок — это
    // документ, который читают вместо кода и который врёт.
    expect(readFileSync(SCHEMA_SNAPSHOT, 'utf8')).toBe(renderSnapshot());
  });
});
