import { describe, expect, it } from 'vitest';
import { REDACTED, UNPARSABLE, redactConnectionString, redactedDatabaseUrl } from '../src/redact.ts';

const PASSWORD = 'hunter2-correct-horse';

describe('redactConnectionString', () => {
  it('пароль в части пользователя не печатается', () => {
    const printed = redactConnectionString(`postgresql://sdelka:${PASSWORD}@db.local:5432/sdelka`);
    expect(printed).not.toContain(PASSWORD);
    expect(printed).toContain(REDACTED);
  });

  it('хост, порт, база и пользователь остаются: на них дежурный и смотрит', () => {
    const printed = redactConnectionString(`postgresql://sdelka:${PASSWORD}@db.local:5432/sdelka`);
    expect(printed).toContain('db.local:5432');
    expect(printed).toContain('/sdelka');
    expect(printed).toContain('sdelka:');
  });

  it('пароль в параметрах запроса — тоже пароль', () => {
    const printed = redactConnectionString(
      `postgresql://sdelka@db.local:5432/sdelka?password=${PASSWORD}&sslmode=require`,
    );
    expect(printed).not.toContain(PASSWORD);
    expect(printed).toContain('sslmode=require');
  });

  it('ключ и файл пароля закрываются вместе с ним', () => {
    const printed = redactConnectionString(
      `postgresql://db.local/sdelka?sslpassword=${PASSWORD}&sslkey=${PASSWORD}&passfile=${PASSWORD}`,
    );
    expect(printed).not.toContain(PASSWORD);
  });

  it('длина пароля не проступает: замена постоянная', () => {
    const short = redactConnectionString('postgresql://u:a@h/d');
    const long = redactConnectionString('postgresql://u:aaaaaaaaaaaaaaaaaaaa@h/d');
    expect(short).toBe(long);
  });

  it('строка без пароля печатается как есть', () => {
    expect(redactConnectionString('postgresql://sdelka@127.0.0.1:5432/sdelka_dev')).toBe(
      'postgresql://sdelka@127.0.0.1:5432/sdelka_dev',
    );
  });

  it('неразобранная строка не печатается вовсе', () => {
    // Формат keyword/value — законная строка подключения Postgres, `URL` её не
    // разбирает. Вернуть её «как есть» = напечатать пароль.
    const dsn = `host=db.local user=sdelka password=${PASSWORD}`;
    expect(redactConnectionString(dsn)).toBe(UNPARSABLE);
    expect(redactConnectionString(dsn)).not.toContain(PASSWORD);
  });

  it('мусор не печатается', () => {
    expect(redactConnectionString('')).toBe(UNPARSABLE);
    expect(redactConnectionString(PASSWORD)).toBe(UNPARSABLE);
  });
});

describe('redactedDatabaseUrl', () => {
  it('берёт строку из окружения и печатает её без пароля', () => {
    const printed = redactedDatabaseUrl({
      SDELKA_DATABASE_URL: `postgresql://sdelka:${PASSWORD}@db.local:5432/sdelka`,
    });
    expect(printed).not.toBeNull();
    expect(printed).not.toContain(PASSWORD);
  });

  it('нечего печатать — печатает null, а не выдумывает', () => {
    expect(redactedDatabaseUrl({})).toBeNull();
    expect(redactedDatabaseUrl({ SDELKA_DATABASE_URL: '' })).toBeNull();
    expect(redactedDatabaseUrl({ SDELKA_DATABASE_URL: '   ' })).toBeNull();
  });
});
