import { describe, expect, it, vi } from 'vitest';
import { failureLine, findingLine, reportFailure } from '../src/cli/report.ts';
import { databaseNameOf, libpqEnv, redactConnectionString } from '../src/connection.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';
import { run, runOrThrow, scrub, tail } from '../src/exec.ts';

/**
 * Красная линия №12, проверенная одним утверждением: **маркерный пароль не
 * появляется нигде**.
 *
 * Нигде — это в выводе команды, в тексте отказа, в `details`, в `message`, в
 * `stack` и в том, что получится, если ошибку целиком сериализовать (так её
 * пишет в журнал любой сборщик логов). Проверять по одному месту бесполезно:
 * пароль утекает не там, где его печатают нарочно, а там, где печатают «весь
 * объект ошибки, чтобы было понятнее».
 *
 * Значение выдумано и живёт только в этом наборе. Настоящих секретов в
 * репозитории нет ни одного.
 */
const MARKER = 'zXq-marker-7f3c9d';

/** Все места, в которых ошибка может проговориться. */
function surfaces(error: unknown): readonly string[] {
  const parts: string[] = [failureLine(error)];
  const captured: string[] = [];
  reportFailure(error, (line) => captured.push(line));
  parts.push(...captured);
  if (error instanceof Error) {
    parts.push(error.message, error.stack ?? '', String(error));
  }
  if (error instanceof BackupError) {
    parts.push(JSON.stringify(error.details));
  }
  // Так ошибку печатает сборщик журналов: целиком, вместе с собственными
  // свойствами. У `pg` в них лежат и хост, и пользователь.
  parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})));
  return parts;
}

function expectNoMarker(parts: readonly string[]): void {
  for (const part of parts) {
    expect(part).not.toContain(MARKER);
  }
}

describe('пароль не доезжает до вывода', () => {
  it.each([
    ['user:pass@host', `postgresql://u:${MARKER}@host:5432/db`],
    ['параметр password', `postgresql://host/db?password=${MARKER}&sslmode=require`],
    ['параметр в чужой схеме', `mysql://u:${MARKER}@host/db`],
    ['неразбираемая строка', `host=127.0.0.1 password=${MARKER} dbname=x`],
    ['пароль со знаками URL', `postgresql://u:${encodeURIComponent(`${MARKER}/@:?#`)}@host/db`],
  ])('%s: печатный вид молчит', (_name, connectionString) => {
    expect(redactConnectionString(connectionString)).not.toContain(MARKER);
  });

  it.each([
    ['неразбираемая строка', `host=127.0.0.1 password=${MARKER} dbname=x`],
    ['чужая схема', `mysql://u:${MARKER}@host/db`],
  ])('%s: отказ разбора молчит во всех своих полях', (_name, connectionString) => {
    const error = (() => {
      try {
        libpqEnv(connectionString);
        return null;
      } catch (item: unknown) {
        return item;
      }
    })();
    expect(error).toBeInstanceOf(BackupError);
    expectNoMarker(surfaces(error));
  });

  it('отказ имени базы молчит так же: путь другой, правило одно', () => {
    const error = (() => {
      try {
        databaseNameOf(`mysql://u:${MARKER}@host/db`);
        return null;
      } catch (item: unknown) {
        return item;
      }
    })();
    expectNoMarker(surfaces(error));
  });

  it('расхождение сверки печатается ключом и подробностями — и в них пароля нет', () => {
    const line = findingLine({
      code: BackupErrorCode.tableRowsMismatch,
      details: { table: 'ledger_entry', expected: '2', actual: '1' },
    });
    expect(line).toBe('backup.verify.table_rows_mismatch table=ledger_entry expected=2 actual=1');
    expect(line).not.toContain(MARKER);
  });
});

/* ------------------------------------------------------------------------- */
/* Вывод дочерней команды                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Дочерняя команда, печатающая **всё своё окружение** в поток и падающая.
 *
 * Так себя ведёт libpq: строка подключения появляется в некоторых её
 * сообщениях об ошибке, и вырезание пароля из `stderr` заведено ровно на этот
 * случай. Само окружение печатается перебором ключей: имя переменной с паролем
 * в аргументах процесса не появляется — их читает `/proc/<pid>/cmdline`.
 */
const SPILL = (stream: 'stdout' | 'stderr', exit: number): readonly string[] => [
  '-e',
  `process.${stream}.write(Object.keys(process.env).map((k) => k + '=' + process.env[k]).join(' ') + '\\n');` +
    `process.exit(${String(exit)});`,
];

describe('вывод дочерней команды чистится от пароля', () => {
  it('stderr упавшей команды приезжает в отказ уже без пароля', async () => {
    const error = await runOrThrow(process.execPath, SPILL('stderr', 3), {
      env: { PGPASSWORD: MARKER, PGDATABASE: 'sdelka_prod' },
    }).catch((item: unknown) => item);
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(BackupErrorCode.commandFailed);
    // Вывод в отказ доехал — иначе проверка была бы вхолостую.
    expect((error as BackupError).details.stderr).toContain('PGDATABASE=sdelka_prod');
    expect((error as BackupError).details.stderr).toContain('<redacted>');
    expectNoMarker(surfaces(error));
  });

  it('stdout удачной команды тоже чистится: печатают его те же люди', async () => {
    const result = await run(process.execPath, SPILL('stdout', 0), {
      env: { PGPASSWORD: MARKER },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('<redacted>');
    expect(result.stdout).not.toContain(MARKER);
  });

  it('чужие PG* родителя не наследуются: копия иначе снялась бы не с той базы', async () => {
    vi.stubEnv('PGDATABASE', 'someone_elses_db');
    vi.stubEnv('PGPASSWORD', MARKER);
    try {
      const result = await run(process.execPath, SPILL('stdout', 0), {
        env: { PGDATABASE: 'sdelka_prod' },
      });
      expect(result.stdout).toContain('PGDATABASE=sdelka_prod');
      expect(result.stdout).not.toContain('someone_elses_db');
      // Пароль родителя не попал в дочерний процесс вовсе, поэтому и вырезать
      // его нечем — вырезание работает только по переданному значению.
      expect(result.stdout).not.toContain('PGPASSWORD');
      expect(result.stdout).not.toContain(MARKER);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('пустой пароль ничего не вырезает: иначе вырезалось бы всё', () => {
    expect(scrub('host=db user=sdelka', '')).toBe('host=db user=sdelka');
    expect(scrub('host=db user=sdelka', undefined)).toBe('host=db user=sdelka');
  });

  it('хвост вывода берётся с конца и без пустых строк', () => {
    expect(tail('a\n\nb\nc\n', 2)).toBe('b | c');
  });
});
