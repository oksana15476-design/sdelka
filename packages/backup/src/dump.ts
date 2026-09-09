import { open, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { takeCensus } from './census.ts';
import { databaseNameOf, libpqEnv } from './connection.ts';
import { runOrThrow } from './exec.ts';
import {
  type BackupManifest,
  CHECKSUMS_SUFFIX,
  DUMP_SUFFIX,
  MANIFEST_FORMAT_VERSION,
  MANIFEST_SUFFIX,
  fileSha256,
  renderChecksums,
  serializeManifest,
} from './manifest.ts';
import { backupPool } from './pool.ts';

/**
 * Снятие копии.
 *
 * **Согласованность — не побочный эффект, а построение.** `pg_dump` и так
 * работает в одной транзакции с уровнем `REPEATABLE READ`, поэтому середины
 * чужой транзакции он не видит никогда. Но нам мало согласованности самого
 * дампа: перепись, с которой копия потом сверяется (`census.ts`), обязана быть
 * снята **в том же самом состоянии базы**. Иначе каждое расхождение при
 * проверке объясняется словами «наверное, между дампом и переписью что-то
 * дописалось», а проверка, которую можно так объяснить, ничего не проверяет.
 *
 * Отсюда порядок:
 *
 * 1. открывается транзакция `REPEATABLE READ READ ONLY` и экспортируется
 *    снимок (`pg_export_snapshot`);
 * 2. `pg_dump` запускается с `--snapshot=<тот же снимок>` — он не берёт свой,
 *    а присоединяется к нашему;
 * 3. перепись считается в **той же** транзакции, уже после `pg_dump`;
 * 4. транзакция закрывается.
 *
 * Экспортирующая сессия всё время работы `pg_dump` простаивает внутри
 * транзакции. Поэтому пул у пакета свой, со снятыми серверными сроками
 * (`pool.ts`): с настройками приложения сервер убил бы её через тридцать
 * секунд, и копия перестала бы сниматься ровно тогда, когда база доросла до
 * размера, при котором копия и нужна.
 *
 * **Права на файлы.** Копия содержит персональные данные и вечный журнал.
 * Файлы создаются с правами `0600`, каталог — `0700`, и файл дампа заводится
 * **до** запуска `pg_dump`: тот открывает существующий файл на запись, не меняя
 * прав, — иначе между созданием файла с правами по умолчанию и `chmod` есть
 * окно, в которое копию успевает прочитать кто угодно.
 */
export interface BackupOptions {
  readonly connectionString: string;
  readonly directory: string;
  readonly now?: Date;
}

export interface BackupResult {
  readonly base: string;
  readonly dumpPath: string;
  readonly manifestPath: string;
  readonly checksumsPath: string;
  readonly manifest: BackupManifest;
}

/** Права каталога и файлов копии. Восьмеричные, а не «как получится». */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Сколько `pg_dump` ждёт блокировку таблицы. По умолчанию — вечно, и это
 * худший из исходов для задания по расписанию: копия не снимается, задание не
 * завершается, отказа нет, и заметить это можно только тогда, когда копия
 * понадобится. Пять минут — заведомо больше любой нашей операции и заведомо
 * меньше ночного окна.
 */
const LOCK_WAIT = '5min';

export function timestampOf(now: Date): string {
  return now.toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
}

async function toolVersion(env: Readonly<Record<string, string>>): Promise<string> {
  const result = await runOrThrow('pg_dump', ['--version'], { env });
  return result.stdout.trim();
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const env = libpqEnv(options.connectionString);
  const database = databaseNameOf(options.connectionString);
  const now = options.now ?? new Date();
  const base = join(options.directory, `sdelka-${database}-${timestampOf(now)}`);
  const dumpPath = `${base}${DUMP_SUFFIX}`;
  const manifestPath = `${base}${MANIFEST_SUFFIX}`;
  const checksumsPath = `${base}${CHECKSUMS_SUFFIX}`;

  await mkdir(options.directory, { recursive: true, mode: DIR_MODE });
  // Файл заводится пустым и с нужными правами до того, как в него польются
  // данные. `wx` — отказ, если файл уже есть: наступать на чужую копию нельзя.
  await (await open(dumpPath, 'wx', FILE_MODE)).close();

  const tool = await toolVersion(env);
  const pool = backupPool(options.connectionString);
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const exported = await client.query<{ snapshot: string }>(
        'SELECT pg_export_snapshot() AS snapshot',
      );
      const snapshot = exported.rows[0]?.snapshot;
      if (snapshot === undefined) throw new Error('backup.snapshot.missing');
      const server = await client.query<{ server_version: string }>('SHOW server_version');

      await runOrThrow(
        'pg_dump',
        [
          '--format=custom',
          `--snapshot=${snapshot}`,
          `--lock-wait-timeout=${LOCK_WAIT}`,
          // Владельцы и гранты сохраняются намеренно: инвариант 21 («роль
          // приложения не имеет прав на изменение и удаление журнала аудита»)
          // держится грантами, и копия, восстановленная без них, — это база,
          // в которой вечный журнал редактируем.
          '--no-password',
          `--file=${dumpPath}`,
        ],
        { env },
      );

      const census = await takeCensus(client);
      await client.query('COMMIT');

      const bytes = (await stat(dumpPath)).size;
      const manifest: BackupManifest = Object.freeze({
        formatVersion: MANIFEST_FORMAT_VERSION,
        takenAt: now.toISOString(),
        database,
        serverVersion: server.rows[0]?.server_version ?? '',
        toolVersion: tool,
        dumpFile: basename(dumpPath),
        dumpBytes: bytes.toString(),
        dumpSha256: await fileSha256(dumpPath),
        census,
      });
      const manifestText = serializeManifest(manifest);
      await writeFile(manifestPath, manifestText, { encoding: 'utf8', mode: FILE_MODE });
      await writeFile(
        checksumsPath,
        renderChecksums([
          { digest: manifest.dumpSha256, file: manifest.dumpFile },
          { digest: await fileSha256(manifestPath), file: basename(manifestPath) },
        ]),
        { encoding: 'utf8', mode: FILE_MODE },
      );
      return Object.freeze({ base, dumpPath, manifestPath, checksumsPath, manifest });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
