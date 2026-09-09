import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { databaseNameOf, libpqEnv, withDatabaseName } from './connection.ts';
import { BackupError, BackupErrorCode } from './errors.ts';
import { runOrThrow } from './exec.ts';
import {
  type BackupManifest,
  CHECKSUMS_SUFFIX,
  DUMP_SUFFIX,
  MANIFEST_SUFFIX,
  baseNameOf,
  digestOf,
  fileSha256,
  parseChecksums,
  readManifestFile,
} from './manifest.ts';

/**
 * Восстановление копии в **чистую** базу.
 *
 * ⚠ Эта функция обслуживает **учение**, а не аварию. Она пересоздаёт целевую
 * базу целиком, поэтому цель обязана быть отдельной: восстановление на боевое
 * имя — отдельная ручная процедура, описанная в `docs/OPERATIONS.md`, и
 * делается человеком, который в этот момент понимает, что делает. Автоматика,
 * умеющая снести боевую базу, однажды её и снесёт.
 *
 * Порядок:
 *
 * 1. **сначала контрольные суммы**, потом всё остальное. Обрезанный дамп
 *    `pg_restore` читает молча ровно до места обрыва и завершается успехом на
 *    том, что успел прочитать: без сверки хеша половина базы неотличима от
 *    целой базы;
 * 2. цель сносится и создаётся заново из `template0` — восстановление поверх
 *    остатков прошлого прогона проверяло бы прошлый прогон;
 * 3. `pg_restore --single-transaction --exit-on-error`: либо база
 *    восстановлена целиком, либо не тронута. Половина восстановленной базы —
 *    худший исход из возможных, потому что она выглядит рабочей.
 *
 * Владельцы и гранты восстанавливаются как есть. Инвариант 21 — «роль
 * приложения не имеет прав на изменение и удаление журнала аудита» — держится
 * грантами, и копия, восстановленная с `--no-owner --no-acl`, дала бы базу, в
 * которой вечный журнал редактируем. Поэтому роли `sdelka_owner` и `sdelka_app`
 * обязаны существовать в кластере **до** восстановления: `pg_dump` их не
 * переносит, они кластерные.
 */
export interface BackupSet {
  readonly base: string;
  readonly dumpPath: string;
  readonly manifestPath: string;
  readonly checksumsPath: string;
  readonly manifest: BackupManifest;
}

/**
 * Читает набор и **сверяет контрольные суммы обоих файлов**. Слепок проверяется
 * наравне с дампом: сверка идёт против слепка, и подменённый слепок сделал бы
 * проверку тождеством «сходится с самим собой».
 *
 * Контуров два, и второй не украшение: запись о дампе есть и в файле `.sha256`,
 * и **в самом слепке**. Первый контур ловит порчу файла, второй — пересчёт
 * сумм после порчи. Разбор — у кода сверки ниже.
 */
export async function openBackupSet(path: string): Promise<BackupSet> {
  const base = baseNameOf(path);
  const dumpPath = `${base}${DUMP_SUFFIX}`;
  const manifestPath = `${base}${MANIFEST_SUFFIX}`;
  const checksumsPath = `${base}${CHECKSUMS_SUFFIX}`;
  const checksums = parseChecksums(await readFile(checksumsPath, 'utf8'));

  const digests = new Map<string, string>();
  for (const file of [dumpPath, manifestPath]) {
    // Имя файла — `basename`, а не срез по длине каталога. Срез был неверен на
    // пути без каталога: `dirname('x.dump')` — это `.`, длиной в один знак, и
    // от имени отрезались два первых знака. Дежурный, запустивший проверку из
    // каталога с копией, получал `backup.set.incomplete file=ump` — отказ,
    // который читается как «набор неполон», хотя набор цел.
    const name = basename(file);
    const expected = digestOf(checksums, name);
    const actual = await fileSha256(file);
    digests.set(name, actual);
    if (actual !== expected) {
      throw new BackupError(BackupErrorCode.digestMismatch, {
        file: name,
        expected: expected.slice(0, 8),
        actual: actual.slice(0, 8),
      });
    }
  }
  const manifest = await readManifestFile(manifestPath);

  // Второй контур: **слепок несёт свою запись о дампе**, и она сверяется тоже.
  //
  // Файл `.sha256` сходится сам с собой ровно до тех пор, пока его никто не
  // пересчитал. Пересчитывают его не злоумышленники, а хранилища: копия
  // доехала обрезанной, приёмная сторона взяла хеш того, что получила, и
  // положила рядом. После этого первый контур молчит — сходится обрезанное с
  // обрезанным. Слепок пересчитан при этом не будет: его пишет снятие, а не
  // приёмка.
  const dumpFile = basename(dumpPath);
  const dumpDigest = digests.get(dumpFile) ?? '';
  if (manifest.dumpSha256 !== dumpDigest) {
    throw new BackupError(BackupErrorCode.digestMismatch, {
      file: dumpFile,
      reason: 'manifest',
      expected: manifest.dumpSha256.slice(0, 8),
      actual: dumpDigest.slice(0, 8),
    });
  }
  const bytes = (await stat(dumpPath)).size;
  if (manifest.dumpBytes !== bytes.toString()) {
    throw new BackupError(BackupErrorCode.digestMismatch, {
      file: dumpFile,
      reason: 'bytes',
      expected: manifest.dumpBytes,
      actual: bytes.toString(),
    });
  }

  return Object.freeze({ base, dumpPath, manifestPath, checksumsPath, manifest });
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/u;

/** Служебная база того же кластера: снести и создать цель, к ней не подключаясь. */
export const DEFAULT_ADMIN_DATABASE = 'postgres';

export interface RestoreOptions {
  readonly set: BackupSet;
  /** Куда восстанавливаем. Пересоздаётся целиком. */
  readonly targetUrl: string;
  /** Откуда управляем. По умолчанию — та же строка с базой `postgres`. */
  readonly adminUrl?: string;
}

export async function restoreForDrill(options: RestoreOptions): Promise<void> {
  const target = databaseNameOf(options.targetUrl);
  if (!IDENTIFIER.test(target)) {
    throw new BackupError(BackupErrorCode.urlInvalid, { reason: 'target_name' });
  }
  if (target === options.set.manifest.database) {
    // Имя цели совпало с именем источника. Совпадение имён не доказывает, что
    // это та же база (кластеры бывают разные), но допустить обратное дороже:
    // цена ошибки здесь — снесённая боевая база.
    throw new BackupError(BackupErrorCode.targetIsSource, { database: target });
  }
  const adminUrl = options.adminUrl ?? withDatabaseName(options.targetUrl, DEFAULT_ADMIN_DATABASE);
  const adminEnv = libpqEnv(adminUrl);
  const psql = ['--no-password', '--quiet', '-v', 'ON_ERROR_STOP=1', '--command'];
  // `WITH (FORCE)` — брошенное соединение прошлого прогона иначе подвешивает
  // `DROP DATABASE` навсегда, и учение превращается в зависшее задание.
  await runOrThrow('psql', [...psql, `DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`], {
    env: adminEnv,
  });
  await runOrThrow('psql', [...psql, `CREATE DATABASE "${target}" TEMPLATE template0`], {
    env: adminEnv,
  });
  await runOrThrow(
    'pg_restore',
    [
      // `--dbname` обязателен и **не выводится** из `PGDATABASE`: без него
      // `pg_restore` не подключается вовсе, а печатает восстановленный SQL в
      // `stdout` и завершается с ошибкой «one of -d/--dbname and -f/--file must
      // be specified». Прежняя редакция полагалась на переменную окружения — то
      // есть восстановление не работало ни разу, и узнать об этом можно было
      // только в день, когда копия понадобилась.
      //
      // В `argv` уходит **имя базы, а не строка подключения**: имя секретом не
      // является (оно же стоит в слепке и в командах `psql` выше), а хост,
      // пользователь и пароль по-прежнему приезжают переменными `PG*`
      // (красная линия №12).
      `--dbname=${target}`,
      '--single-transaction',
      '--exit-on-error',
      '--no-password',
      options.set.dumpPath,
    ],
    { env: libpqEnv(options.targetUrl) },
  );
}

/** Путь набора по каталогу и имени. Нужен командам и тестам, чтобы не склеивать руками. */
export function setPath(directory: string, base: string): string {
  return join(directory, `${base}${DUMP_SUFFIX}`);
}
