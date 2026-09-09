import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigErrorCode } from '../src/errors.ts';

/**
 * Ворота старта целиком, процессом: не хватает обязательной переменной — код
 * возврата не ноль. Проверять это в обход процесса нельзя: «не поднимается» —
 * свойство запуска, а не функции.
 */

const CLI = fileURLToPath(new URL('../src/cli/check-env.ts', import.meta.url));
const SECRET = 'postgresql://sdelka:CANARY-SECRET@db.local:5432/sdelka';

/**
 * Полный набор обязательных переменных приложения.
 *
 * Перечисляется здесь, а не наследуется из окружения прогона: набор, зависящий
 * от того, что задано на машине запускающего, проверяет разное у разных людей.
 * Значения — заведомо не боевые; секрет-канарейка остаётся один, по нему
 * проверяется, что значения не печатаются.
 */
const COMPLETE: Readonly<Record<string, string>> = {
  SDELKA_DATABASE_URL: SECRET,
  SDELKA_AUTH_MODE: 'development',
  SDELKA_AUTH_CODE_KEY: 'not-a-real-key-0123456789abcdef',
};

function run(overrides: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, ...COMPLETE };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', CLI], {
    env,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('pnpm env:check', () => {
  it('без обязательной переменной — отказ с её именем и ненулевой код', () => {
    const result = run({ SDELKA_DATABASE_URL: undefined });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ConfigErrorCode.envIncomplete);
    expect(result.stderr).toContain('SDELKA_DATABASE_URL');
    expect(result.stderr).toContain(ConfigErrorCode.envAbsent);
  });

  it('пустая строка считается отсутствием — и говорит об этом отдельно', () => {
    const result = run({ SDELKA_DATABASE_URL: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ConfigErrorCode.envBlank);
    expect(result.stderr).toContain('SDELKA_DATABASE_URL');
  });

  it('пробелы вместо значения — тоже отказ', () => {
    expect(run({ SDELKA_DATABASE_URL: '   ' }).status).toBe(1);
  });

  it('полный набор проходит', () => {
    const result = run({ SDELKA_DATABASE_URL: SECRET });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config.env.ok');
  });

  it('значение переменной не печатается ни при успехе, ни при отказе', () => {
    const passing = run({ SDELKA_DATABASE_URL: SECRET });
    expect(passing.stdout + passing.stderr).not.toContain('CANARY-SECRET');

    // Секрет задан, но изъян есть у другой переменной: значение всё равно молчит.
    const failing = run({ SDELKA_DATABASE_URL: '' });
    expect(failing.stdout + failing.stderr).not.toContain('CANARY-SECRET');
  });

  it('отказ уходит в stderr, а не в stdout: успех и отказ не путаются в конвейере', () => {
    const result = run({ SDELKA_DATABASE_URL: undefined });
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toBe('');
  });
});
