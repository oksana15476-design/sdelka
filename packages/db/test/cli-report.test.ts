import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { failureLine, reportFailure } from '../src/cli/report.ts';
import { DbError, DbErrorCode } from '../src/errors.ts';

/**
 * Вывод команд развёртывания.
 *
 * Проверяется здесь одно, и оно важнее вида строки: **в отказе нет строки
 * подключения**. `console.error(error)` напечатал бы её целиком — у ошибки
 * драйвера `pg` в свойствах лежат хост, пользователь и пароль, и попадают они
 * в журнал развёртывания, который читают все.
 */
describe('строка отказа команды', () => {
  it('наш отказ — технический ключ и подробности', () => {
    expect(
      failureLine(new DbError(DbErrorCode.schemaBehind, { expected: '0023', versions: '0022' })),
    ).toBe('db.schema.behind expected=0023 versions=0022');
  });

  it('пустые подробности не печатаются', () => {
    expect(failureLine(new DbError(DbErrorCode.schemaNotInitialized, { versions: '' }))).toBe(
      'db.schema.not_initialized',
    );
  });

  it('чужая ошибка — имя и сообщение, без стека и без свойств', () => {
    const error = Object.assign(new DatabaseError('permission denied', 100, 'error'), {
      code: '42501',
      // Так драйвер носит адрес базы: в свойствах ошибки, а не в сообщении.
      client: { connectionParameters: { host: 'db.internal', password: 'ОЧЕНЬ-СЕКРЕТНО' } },
    });
    const line = failureLine(error);
    expect(line).toBe('error: permission denied');
    expect(line).not.toContain('ОЧЕНЬ-СЕКРЕТНО');
    expect(line).not.toContain('db.internal');
  });

  it('не-ошибка печатается как есть и не роняет команду', () => {
    expect(failureLine('что-то')).toBe('что-то');
  });

  it('отказ даёт код выхода один и пишет ровно одну строку', () => {
    const written: string[] = [];
    const code = reportFailure(new DbError(DbErrorCode.schemaAhead, { versions: '9999' }), (line) =>
      written.push(line),
    );
    expect(code).toBe(1);
    expect(written).toEqual(['db.schema.ahead versions=9999\n']);
  });
});
