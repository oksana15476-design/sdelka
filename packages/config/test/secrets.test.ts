import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.ts';
import { ENV_REGISTRY, secretVariableNames } from '../src/registry.ts';
import { assertEnvironment, checkEnvironment, describeEnvironmentCheck } from '../src/startup.ts';

/**
 * Красная линия №12 с другой стороны: секрет не должен утечь **в вывод**.
 *
 * Проверка не смотрит на код и не верит комментариям. Она подставляет каждой
 * переменной опознаваемое значение и требует, чтобы ни одно из них не нашлось
 * ни в отчёте, ни в тексте отказа, ни в исключении.
 */

const MARK = 'CANARY-VALUE-MUST-NOT-APPEAR';

function markedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const variable of ENV_REGISTRY) env[variable.name] = `${MARK}-${variable.name}`;
  return env;
}

describe('секрет не попадает в вывод', () => {
  it('в перечне есть хотя бы один секрет — иначе проверка ничего не проверяет', () => {
    expect(secretVariableNames()).toContain('SDELKA_DATABASE_URL');
  });

  it('отчёт о полном наборе не несёт значений', () => {
    const check = checkEnvironment(markedEnv(), 'app');
    expect(JSON.stringify(check)).not.toContain(MARK);
  });

  it('текст отказа несёт имена, а не значения', () => {
    // Секрет задан пустым: изъян есть, значение «пустое» — и всё равно ни одно
    // значение остальных переменных в текст не попадает.
    const env = markedEnv();
    env['SDELKA_DATABASE_URL'] = '';
    const text = describeEnvironmentCheck(checkEnvironment(env, 'app'));
    expect(text).toContain('SDELKA_DATABASE_URL');
    expect(text).not.toContain(MARK);
  });

  it('исключение не несёт значений — ни в details, ни в message', () => {
    const env = markedEnv();
    env['SDELKA_DATABASE_URL'] = '';
    let error: ConfigError | null = null;
    try {
      assertEnvironment(env, 'app');
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error).not.toBeNull();
    expect(JSON.stringify(error?.details)).not.toContain(MARK);
    expect(error?.message).not.toContain(MARK);
    expect(String(error?.stack)).not.toContain(MARK);
  });

  it('значение секрета не попадает и тогда, когда изъян в другой переменной', () => {
    const env = markedEnv();
    const secret = 'SDELKA_DATABASE_URL';
    env[secret] = `${MARK}-live-secret`;
    const check = checkEnvironment(env, 'app');
    expect(describeEnvironmentCheck(check)).not.toContain(MARK);
  });
});
