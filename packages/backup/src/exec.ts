import { spawn } from 'node:child_process';
import { BackupError, BackupErrorCode } from './errors.ts';

/**
 * Запуск внешней команды `pg_dump`/`pg_restore`/`psql`.
 *
 * Три правила, и все три про секреты и про то, что читает дежурный.
 *
 * 1. **Окружение дочернего процесса собирается явно.** Не `{...process.env,
 *    ...}`: в окружении родителя лежат чужие `PG*` (например, от прогона
 *    тестов), и они молча переопределили бы адрес — копия снялась бы не с той
 *    базы и отчиталась бы об успехе. Пропускаем поимённо `PATH`, `HOME`,
 *    `LANG`, `TMPDIR` — минимум, без которого libpq и сама команда не работают.
 * 2. **`argv` без секретов.** Строка подключения приходит переменными `PG*`
 *    (`connection.ts`), сюда — уже разложенной.
 * 3. **Оба потока перед печатью чистятся от пароля.** Он не должен там
 *    появиться ни при каком исходе, но «не должен» — не то же самое, что «не
 *    появится»: libpq печатает строку подключения в некоторых сообщениях об
 *    ошибке. `stdout` чистится наравне со `stderr`: сегодня из него читается
 *    только версия `pg_dump`, но правило «этот поток можно печатать, а тот
 *    нельзя» держится памятью читающего, а не кодом, — и первый же вывод
 *    команды, печатающей отчёт в `stdout`, его нарушит молча.
 */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Хвост вывода: полный `stderr` восстановления — это тысячи строк DDL. */
const STDERR_TAIL_LINES = 20;

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PGSYSCONFDIR'] as const;

function childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSTHROUGH_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Вырезает пароль из текста. Пустой пароль ничего не вырезает: иначе вырезалось бы всё. */
export function scrub(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join('<redacted>');
}

export function tail(text: string, lines: number = STDERR_TAIL_LINES): string {
  const all = text.split('\n').filter((line) => line.trim().length > 0);
  return all.slice(-lines).join(' | ');
}

export interface RunOptions {
  readonly env: Readonly<Record<string, string>>;
}

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  const env = childEnv(options.env);
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Команды нет в `PATH` — отдельный отказ: он чинится установкой пакета
      // клиента, а не разбором вывода.
      if (error.code === 'ENOENT') {
        reject(new BackupError(BackupErrorCode.commandMissing, { command }));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: scrub(stdout, options.env.PGPASSWORD),
        stderr: scrub(stderr, options.env.PGPASSWORD),
      });
    });
  });
}

/** То же, но ненулевой код выхода — отказ с именем команды и хвостом `stderr`. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<CommandResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new BackupError(BackupErrorCode.commandFailed, {
      command,
      exit: String(result.code),
      stderr: tail(result.stderr),
    });
  }
  return result;
}
