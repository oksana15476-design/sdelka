import { describe, expect, it } from 'vitest';
import { UNKNOWN_CODE, healthReport, safeCode } from './state';

describe('ответ проверки здоровья', () => {
  it('готовая база — 200 и версия схемы', () => {
    expect(healthReport({ kind: 'ready', schema: '0023' })).toEqual({
      status: 200,
      body: { status: 'ok', db: 'ready', schema: '0023' },
    });
  });

  it('ненакаченная база — не здоровье: 503', () => {
    expect(healthReport({ kind: 'unmigrated' }).status).toBe(503);
  });

  it('недоступная база — 503, род назван', () => {
    expect(healthReport({ kind: 'unreachable' })).toEqual({
      status: 503,
      body: { status: 'fail', db: 'unreachable' },
    });
  });

  it('строки подключения нет — 503, а не тихое «ok»', () => {
    expect(healthReport({ kind: 'unconfigured' }).body.db).toBe('unconfigured');
  });

  it('отказ базы отдаёт код', () => {
    expect(healthReport({ kind: 'error', code: '28P01' }).body.code).toBe('28P01');
  });
});

describe('фильтр кода отказа — красная линия №12', () => {
  it('пропускает наши ключи и SQLSTATE', () => {
    expect(safeCode('db.connect.timeout')).toBe('db.connect.timeout');
    expect(safeCode('28P01')).toBe('28P01');
  });

  it('сворачивает всё, что похоже на строку подключения или сообщение', () => {
    for (const code of [
      'postgresql://sdelka:hunter2@db:5432/sdelka',
      'password authentication failed for user "sdelka"',
      'Connection terminated due to connection timeout',
      42,
      undefined,
      null,
    ]) {
      expect(safeCode(code)).toBe(UNKNOWN_CODE);
    }
  });
});
