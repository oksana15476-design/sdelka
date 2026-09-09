import { describe, expect, it } from 'vitest';
import {
  databaseNameOf,
  libpqEnv,
  redactConnectionString,
  withDatabaseName,
} from '../src/connection.ts';
import { BackupError, BackupErrorCode } from '../src/errors.ts';

/**
 * Разбор строки подключения: что доезжает до `pg_dump`, что не доезжает
 * никогда и что из этого можно напечатать.
 *
 * Пароль в наборе один и тот же — `MARKER`. Он опознаётся глазами в любом
 * выводе, и отдельный набор (`secrets.test.ts`) проверяет, что ни в одну строку
 * вывода он не попадает. Значение выдуманное: секретов в репозитории нет
 * (красная линия №12).
 */
const MARKER = 'zXq-marker-7f3c9d';

const WITH_PASSWORD = `postgresql://sdelka_app:${MARKER}@db.internal:6543/sdelka_prod`;

describe('имя базы', () => {
  it('берётся из пути', () => {
    expect(databaseNameOf(WITH_PASSWORD)).toBe('sdelka_prod');
  });

  it('раскодируется: имя с пробелом записано в строке как %20', () => {
    expect(databaseNameOf('postgresql://host/sdelka%20prod')).toBe('sdelka prod');
  });

  it('читается и у строки с сокетом домена Unix, где хоста в адресе нет', () => {
    expect(databaseNameOf('postgresql:///sdelka?host=/var/run/postgresql')).toBe('sdelka');
  });
});

describe('переменные PG* для дочернего процесса', () => {
  it('адрес, личность и база раскладываются поимённо', () => {
    expect(libpqEnv(WITH_PASSWORD)).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGUSER: 'sdelka_app',
      PGPASSWORD: MARKER,
      PGDATABASE: 'sdelka_prod',
    });
  });

  it('имя и пароль раскодируются: в строке они экранированы', () => {
    const env = libpqEnv(`postgresql://u%40corp:${encodeURIComponent('p/@ss')}@host/db`);
    expect(env.PGUSER).toBe('u@corp');
    expect(env.PGPASSWORD).toBe('p/@ss');
  });

  it('IPv6 приезжает без скобок: libpq их не ждёт', () => {
    expect(libpqEnv('postgresql://user@[2001:db8::1]:5432/db').PGHOST).toBe('2001:db8::1');
  });

  it('сокет домена Unix сильнее адреса: параметр host и есть настоящий адрес', () => {
    const env = libpqEnv('postgresql:///sdelka?host=/var/run/postgresql');
    expect(env.PGHOST).toBe('/var/run/postgresql');
    expect(env.PGDATABASE).toBe('sdelka');
  });

  it('шифрование и настройки сессии переносятся: копия не снимается по открытому каналу', () => {
    const env = libpqEnv(
      'postgresql://u@host/db?sslmode=verify-full&sslrootcert=/etc/ssl/pg.crt' +
        '&application_name=backup&connect_timeout=10&options=-c%20statement_timeout%3D0',
    );
    expect(env.PGSSLMODE).toBe('verify-full');
    expect(env.PGSSLROOTCERT).toBe('/etc/ssl/pg.crt');
    expect(env.PGAPPNAME).toBe('backup');
    expect(env.PGCONNECT_TIMEOUT).toBe('10');
    expect(env.PGOPTIONS).toBe('-c statement_timeout=0');
  });

  it('незнакомый параметр отбрасывается, а не переносится наугад', () => {
    const env = libpqEnv('postgresql://u@host/db?target_session_attrs=read-write');
    expect(Object.keys(env).sort()).toEqual(['PGDATABASE', 'PGHOST', 'PGUSER']);
  });

  it('перечень закрыт: возвращённое окружение не дописать задним числом', () => {
    const env = libpqEnv(WITH_PASSWORD);
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe('подстановка имени базы', () => {
  it('меняет базу и сохраняет всё остальное — разбором, а не склейкой', () => {
    const admin = withDatabaseName(WITH_PASSWORD, 'postgres');
    const env = libpqEnv(admin);
    expect(env).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGUSER: 'sdelka_app',
      PGPASSWORD: MARKER,
      PGDATABASE: 'postgres',
    });
  });

  it('сохраняет параметры: служебная база того же кластера требует того же шифрования', () => {
    const admin = withDatabaseName('postgresql://u@host/sdelka?sslmode=require', 'postgres');
    expect(libpqEnv(admin).PGSSLMODE).toBe('require');
  });

  it('имя базы экранируется, а не подставляется как есть', () => {
    expect(databaseNameOf(withDatabaseName('postgresql://host/a', 'b c'))).toBe('b c');
  });
});

describe('печатный вид строки подключения', () => {
  it('пароль вырезан вместе с разделителем, длина не видна', () => {
    const redacted = redactConnectionString(WITH_PASSWORD);
    expect(redacted).toBe('postgresql://sdelka_app@db.internal:6543/sdelka_prod');
    expect(redacted).not.toContain(':' + MARKER);
    expect(redacted).not.toContain('*');
  });

  it('пароль в параметрах вырезан вместе со всеми параметрами', () => {
    expect(
      redactConnectionString(`postgresql://host/db?password=${MARKER}&sslmode=require`),
    ).toBe('postgresql://host/db');
  });

  it('неразбираемая строка не печатается вовсе', () => {
    // Формат keyword/value (`host=… password=…`) URL-ом не разбирается. Не
    // разобралась — не печатаем: чаще всего причина как раз в знаке из пароля.
    expect(redactConnectionString(`host=127.0.0.1 password=${MARKER} dbname=x`)).toBe(
      '<unparseable>',
    );
  });

  it('чужая схема не печатается тоже: пароль в ней ровно там же', () => {
    expect(redactConnectionString(`mysql://u:${MARKER}@host/db`)).toBe('<not-postgres>');
  });
});

describe('отказ разбора', () => {
  const unparseable = `host=127.0.0.1 password=${MARKER} dbname=x`;

  it.each([
    ['имя базы', () => databaseNameOf(unparseable)],
    ['переменные PG*', () => libpqEnv(unparseable)],
    ['подстановка базы', () => withDatabaseName(unparseable, 'postgres')],
  ])('%s: неразбираемая строка — backup.url.invalid без значения', (_name, call) => {
    const error = (() => {
      try {
        call();
        return null;
      } catch (item: unknown) {
        return item;
      }
    })();
    expect(error).toBeInstanceOf(BackupError);
    expect((error as BackupError).code).toBe(BackupErrorCode.urlInvalid);
    expect((error as BackupError).details).toEqual({ reason: 'unparseable' });
  });

  it('чужая схема названа: без неё отказ не диагностируется, а секретом она не является', () => {
    const error = (() => {
      try {
        libpqEnv(`mysql://u:${MARKER}@host/db`);
        return null;
      } catch (item: unknown) {
        return item;
      }
    })();
    expect((error as BackupError).code).toBe(BackupErrorCode.urlInvalid);
    expect((error as BackupError).details).toEqual({ scheme: 'mysql:' });
  });
});
