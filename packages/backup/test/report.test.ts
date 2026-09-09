import { describe, expect, it } from 'vitest';
import { detailsLine, failureLine, findingLine, reportFailure } from '../src/cli/report.ts';
import { timestampOf } from '../src/dump.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';
import { setPath } from '../src/restore.ts';
import { DUMP_SUFFIX } from '../src/manifest.ts';

/**
 * Вывод команд. Читает его дежурный в три часа ночи, поэтому проверяется не
 * «что-то напечаталось», а ровно то, что напечаталось: технический ключ первым
 * словом (он ищется грепом) и подробности парами `имя=значение`.
 */
describe('строка подробностей', () => {
  it('пустые значения выбрасываются: `expected=` не несёт ничего', () => {
    expect(detailsLine({ table: 'ledger_entry', reason: '', actual: '0' })).toBe(
      ' table=ledger_entry actual=0',
    );
  });

  it('без подробностей строка пуста, а не «undefined»', () => {
    expect(detailsLine({})).toBe('');
  });
});

describe('строка отказа', () => {
  it('у ошибки пакета — ключ и подробности', () => {
    expect(
      failureLine(new BackupError(BackupErrorCode.digestMismatch, { file: 'a.dump' })),
    ).toBe('backup.digest.mismatch file=a.dump');
  });

  it('у чужой ошибки той же формы — тот же вывод: пакет не обязан знать бросающего', () => {
    // Так выглядят `DbError` и `AuditError`: проверка по форме, а не по классу.
    const foreign = Object.assign(new Error('db.audit.chain_gap'), {
      code: 'db.audit.chain_gap',
      details: { chainId: 'chain-a', expected: '3', actual: '2' },
    });
    expect(failureLine(foreign)).toBe('db.audit.chain_gap chainId=chain-a expected=3 actual=2');
  });

  it('у обычной ошибки — имя и сообщение, без выдуманного ключа', () => {
    expect(failureLine(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('у не-ошибки — её строковый вид', () => {
    expect(failureLine(42)).toBe('42');
  });

  it('отказ печатается одной строкой и даёт код выхода 1', () => {
    const lines: string[] = [];
    const exit = reportFailure(new BackupError(BackupErrorCode.nothingChecked), (line) =>
      lines.push(line),
    );
    expect(exit).toBe(1);
    expect(lines).toEqual(['backup.verify.nothing_checked\n']);
  });

  it('расхождение сверки печатается тем же складом, что и отказ', () => {
    expect(findingLine({ code: 'backup.verify.chain_head_mismatch', details: { chainId: 'c' } })).toBe(
      'backup.verify.chain_head_mismatch chainId=c',
    );
  });
});

describe('имена набора', () => {
  it('отметка времени — UTC без разделителей: имя файла сортируется само собой', () => {
    expect(timestampOf(new Date('2026-03-01T03:15:00.000Z'))).toBe('20260301T031500Z');
  });

  it('путь набора собирается по каталогу и основе, а не склейкой на месте вызова', () => {
    expect(setPath('/var/backups/sdelka', 'sdelka-prod-20260301T031500Z')).toBe(
      `/var/backups/sdelka/sdelka-prod-20260301T031500Z${DUMP_SUFFIX}`,
    );
  });
});
