import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigErrorCode } from '../src/errors.ts';
import {
  ENV_REGISTRY,
  assertRegistryConsistent,
  envVariableNames,
  findEnvVariable,
  requiredVariables,
  secretVariableNames,
} from '../src/registry.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('перечень переменных', () => {
  it('без дублей', () => {
    expect(() => assertRegistryConsistent()).not.toThrow();
  });

  it('дубль имени — ошибка, а не «победит последний»', () => {
    const twice = [ENV_REGISTRY[0] as (typeof ENV_REGISTRY)[number], ENV_REGISTRY[0]!];
    expect(() => assertRegistryConsistent(twice)).toThrow(ConfigError);
    try {
      assertRegistryConsistent(twice);
    } catch (caught) {
      expect((caught as ConfigError).code).toBe(ConfigErrorCode.registryDuplicate);
    }
  });

  it('имена — верхний регистр и подчёркивания', () => {
    for (const name of envVariableNames()) expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('у секрета нет умолчания: умолчание вместо пароля — секрет в репозитории', () => {
    for (const variable of ENV_REGISTRY) {
      if (!variable.secret) continue;
      expect(variable.fallback, variable.name).toBeNull();
    }
    expect(secretVariableNames().length).toBeGreaterThan(0);
  });

  it('у обязательной нет умолчания: умолчание и обязательность несовместимы', () => {
    for (const variable of ENV_REGISTRY) {
      if (variable.necessity !== 'required') continue;
      expect(variable.fallback, variable.name).toBeNull();
    }
  });

  it('каждая переменная называет читателя, и файлы читателей существуют', () => {
    for (const variable of ENV_REGISTRY) {
      expect(variable.readBy.length, variable.name).toBeGreaterThan(0);
      for (const path of variable.readBy) {
        expect(existsSync(new URL(path, `file://${REPO_ROOT}`)), `${variable.name} → ${path}`).toBe(
          true,
        );
      }
    }
  });

  it('обязательные переменные приложения есть — иначе проверка старта бессмысленна', () => {
    expect(requiredVariables('app').map((variable) => variable.name)).toEqual([
      'SDELKA_DATABASE_URL',
      // Вход: режим канала доставки кода и ключ его вывода. Обе без умолчания
      // намеренно — умолчание вместо них поднимает приложение, в котором код
      // виден в журнале процесса (`auth/src/delivery.ts`).
      'SDELKA_AUTH_MODE',
      'SDELKA_AUTH_CODE_KEY',
    ]);
  });

  it('имя вне перечня — ошибка, а не undefined', () => {
    expect(() => findEnvVariable('NOT_IN_REGISTRY')).toThrow(ConfigError);
  });
});
