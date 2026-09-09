import { BackupError, BackupErrorCode } from './errors.ts';

/**
 * Строка подключения для внешних команд — **через окружение дочернего
 * процесса, а не через аргументы**.
 *
 * `pg_dump --dbname=postgresql://user:пароль@host/db` работает и повсеместно
 * так и написано в руководствах. Проблема в том, что аргументы процесса на
 * Linux читает кто угодно: `/proc/<pid>/cmdline` доступен на чтение, а `ps
 * aux` печатает их всем. Пароль к базе, где лежит вечный журнал и персональные
 * данные, оказывается виден любому процессу на машине ровно на время снятия
 * копии — то есть каждую ночь по расписанию.
 *
 * Поэтому строка разбирается здесь и раскладывается по переменным `PG*`,
 * которые libpq читает сама. В `argv` не попадает ни хост, ни пользователь, ни
 * пароль (красная линия №12).
 *
 * Что переносится и почему именно это:
 *
 * - `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` — адрес и личность;
 * - `PGSSLMODE`, `PGSSLROOTCERT` — иначе копия снималась бы по открытому
 *   каналу на стенде, где строка подключения требует шифрования;
 * - `PGOPTIONS`, `PGAPPNAME` — то, чем строка подключения задаёт поведение
 *   сессии; молча их потерять значит снять копию не в тех настройках.
 *
 * Всё остальное из строки **отбрасывается сознательно**: перечень закрытый, и
 * появление нового параметра обязано быть правкой этого файла, а не тихим
 * «как-нибудь доедет».
 */
export interface LibpqEnv extends Readonly<Record<string, string>> {}

const SCHEMES = new Set(['postgres:', 'postgresql:']);

/** Параметры строки подключения, переносимые в окружение дочернего процесса. */
const PARAM_TO_ENV: ReadonlyMap<string, string> = new Map([
  ['sslmode', 'PGSSLMODE'],
  ['sslrootcert', 'PGSSLROOTCERT'],
  ['sslcert', 'PGSSLCERT'],
  ['sslkey', 'PGSSLKEY'],
  ['options', 'PGOPTIONS'],
  ['application_name', 'PGAPPNAME'],
  ['connect_timeout', 'PGCONNECT_TIMEOUT'],
]);

function parse(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Значение в детали не кладём **никогда**: в нём пароль, и деталь ошибки
    // доезжает и до журнала процесса, и до вывода команды.
    throw new BackupError(BackupErrorCode.urlInvalid, { reason: 'unparseable' });
  }
  if (!SCHEMES.has(url.protocol)) {
    // Схему назвать можно: она не секрет и без неё отказ не диагностируется.
    // Строка `host=… dbname=…` (keyword/value) сюда не доходит — она не URL, и
    // догадываться о ней значит подставить не ту базу.
    throw new BackupError(BackupErrorCode.urlInvalid, { scheme: url.protocol });
  }
  return url;
}

/** Имя базы из строки подключения. Нужно, чтобы не восстановить копию поверх источника. */
export function databaseNameOf(connectionString: string): string {
  const path = parse(connectionString).pathname;
  return decodeURIComponent(path.startsWith('/') ? path.slice(1) : path);
}

export function libpqEnv(connectionString: string): LibpqEnv {
  const url = parse(connectionString);
  const env: Record<string, string> = {};
  // Сокет домена Unix задаётся параметром `host`, а не частью адреса: у
  // `postgresql:///sdelka?host=/var/run/postgresql` hostname пустой. Параметр
  // поэтому сильнее — он и есть настоящий адрес.
  const socket = url.searchParams.get('host');
  if (socket !== null && socket.length > 0) env.PGHOST = socket;
  else if (url.hostname.length > 0) {
    // IPv6 в URL приезжает в скобках, libpq их не ждёт.
    env.PGHOST = url.hostname.replace(/^\[|\]$/gu, '');
  }
  if (url.port.length > 0) env.PGPORT = url.port;
  if (url.username.length > 0) env.PGUSER = decodeURIComponent(url.username);
  if (url.password.length > 0) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = databaseNameOf(connectionString);
  if (database.length > 0) env.PGDATABASE = database;
  for (const [param, variable] of PARAM_TO_ENV) {
    const value = url.searchParams.get(param);
    if (value !== null && value.length > 0) env[variable] = value;
  }
  return Object.freeze(env);
}

/** Та же строка, но с другой базой того же кластера. Разбором, а не склейкой. */
export function withDatabaseName(connectionString: string, database: string): string {
  const url = parse(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Строка подключения в том виде, в каком её можно напечатать.
 *
 * Пароль **вырезается вместе с разделителем**, а не заменяется звёздочками
 * известной длины: длина пароля — тоже сведения о пароле.
 *
 * Неразбираемая строка не печатается вовсе. Соблазн «вернуть как есть, раз уж
 * не разобралось» — это ровно тот путь, которым пароль попадает в журнал: не
 * разобралась она чаще всего потому, что в пароле оказался знак, который никто
 * не экранировал.
 */
export function redactConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return '<unparseable>';
  }
  if (!SCHEMES.has(url.protocol)) return '<not-postgres>';
  url.password = '';
  // `searchParams` строки подключения тоже умеют носить секрет (`sslkey`,
  // `options` с паролем прокси), и разбирать их поимённо здесь незачем: адрес
  // и база — всё, что нужно дежурному, чтобы понять, куда он смотрит.
  url.search = '';
  return url.toString();
}
