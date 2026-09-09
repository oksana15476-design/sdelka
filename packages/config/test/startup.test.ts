import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigErrorCode } from '../src/errors.ts';
import type { EnvVariable } from '../src/registry.ts';
import { ENV_REGISTRY, requiredVariables } from '../src/registry.ts';
import {
  assertEnvironment,
  checkEnvironment,
  describeEnvironmentCheck,
} from '../src/startup.ts';

/** Полный набор для области `app`: у каждой обязательной есть непустое значение. */
function fullAppEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const variable of requiredVariables('app')) env[variable.name] = 'value';
  return env;
}

/** Синтетический перечень: правила проверяются на нём, а не на живых именах. */
const SYNTHETIC: readonly EnvVariable[] = Object.freeze([
  Object.freeze({
    name: 'ALPHA',
    scope: 'app',
    necessity: 'required',
    secret: true,
    fallback: null,
    readBy: Object.freeze(['apps/alpha']),
  }),
  Object.freeze({
    name: 'BETA',
    scope: 'app',
    necessity: 'required',
    secret: false,
    fallback: null,
    readBy: Object.freeze(['apps/beta']),
  }),
  Object.freeze({
    name: 'GAMMA',
    scope: 'app',
    necessity: 'optional',
    secret: false,
    fallback: 'x',
    readBy: Object.freeze(['apps/gamma']),
  }),
  Object.freeze({
    name: 'DELTA',
    scope: 'tooling',
    necessity: 'required',
    secret: false,
    fallback: null,
    readBy: Object.freeze(['scripts/delta']),
  }),
]);

describe('checkEnvironment', () => {
  it('полный набор проходит', () => {
    const check = checkEnvironment(fullAppEnv(), 'app');
    expect(check.ok).toBe(true);
    expect(check.faults).toEqual([]);
  });

  it('набор без обязательной переменной — отказ, и в отказе её имя', () => {
    const required = requiredVariables('app');
    expect(required.length).toBeGreaterThan(0);

    for (const variable of required) {
      const env = fullAppEnv();
      delete env[variable.name];
      const check = checkEnvironment(env, 'app');
      expect(check.ok).toBe(false);
      expect(check.faults.map((fault) => fault.variable)).toContain(variable.name);
      expect(describeEnvironmentCheck(check)).toContain(variable.name);
    }
  });

  it('пустая строка считается отсутствием — но своим ключом', () => {
    for (const variable of requiredVariables('app')) {
      const env = fullAppEnv();
      env[variable.name] = '';
      const check = checkEnvironment(env, 'app');
      expect(check.ok).toBe(false);
      const fault = check.faults.find((item) => item.variable === variable.name);
      expect(fault?.presence).toBe('blank');
      expect(describeEnvironmentCheck(check)).toContain(ConfigErrorCode.envBlank);
    }
  });

  it('пробелы вместо значения — тоже отказ', () => {
    for (const variable of requiredVariables('app')) {
      const env = fullAppEnv();
      env[variable.name] = '  ';
      expect(checkEnvironment(env, 'app').ok).toBe(false);
    }
  });

  it('отказ собирает весь список за один проход, а не первую переменную', () => {
    const check = checkEnvironment({ GAMMA: 'x' }, 'app', SYNTHETIC);
    expect(check.ok).toBe(false);
    expect(check.faults.map((fault) => fault.variable)).toEqual(['ALPHA', 'BETA']);
  });

  it('различает «нет» и «пусто» в одном проходе', () => {
    const check = checkEnvironment({ BETA: '' }, 'app', SYNTHETIC);
    expect(check.faults).toEqual([
      { variable: 'ALPHA', presence: 'absent', readBy: ['apps/alpha'] },
      { variable: 'BETA', presence: 'blank', readBy: ['apps/beta'] },
    ]);
  });

  it('необязательная переменная старт не роняет', () => {
    const check = checkEnvironment({ ALPHA: 'a', BETA: 'b' }, 'app', SYNTHETIC);
    expect(check.ok).toBe(true);
  });

  it('переменные другой области в проверку приложения не входят', () => {
    const check = checkEnvironment({ ALPHA: 'a', BETA: 'b' }, 'app', SYNTHETIC);
    expect(check.faults.map((fault) => fault.variable)).not.toContain('DELTA');
    expect(checkEnvironment({}, 'tooling', SYNTHETIC).faults.map((f) => f.variable)).toEqual([
      'DELTA',
    ]);
  });
});

describe('describeEnvironmentCheck', () => {
  it('называет область, число изъянов и куда смотреть', () => {
    const text = describeEnvironmentCheck(checkEnvironment({}, 'app', SYNTHETIC));
    expect(text.split('\n')[0]).toBe(
      `${ConfigErrorCode.envIncomplete} scope=app count=2 reference=.env.example`,
    );
  });

  it('каждая строка называет читателя: чинить проще, когда видно, кому не хватило', () => {
    const text = describeEnvironmentCheck(checkEnvironment({}, 'app', SYNTHETIC));
    expect(text).toContain(`ALPHA ${ConfigErrorCode.envAbsent} read_by=apps/alpha`);
  });
});

describe('assertEnvironment', () => {
  it('при полном наборе молчит', () => {
    expect(() => assertEnvironment(fullAppEnv(), 'app')).not.toThrow();
  });

  it('бросает ConfigError с именами, разложенными по виду изъяна', () => {
    let error: unknown;
    try {
      assertEnvironment({ BETA: '' }, 'app', SYNTHETIC);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const config = error as ConfigError;
    expect(config.code).toBe(ConfigErrorCode.envIncomplete);
    expect(config.details).toEqual({
      scope: 'app',
      absent: 'ALPHA',
      blank: 'BETA',
      reference: '.env.example',
    });
  });

  it('по умолчанию проверяет живой перечень области приложения', () => {
    expect(() => assertEnvironment({}, 'app')).toThrow(ConfigError);
    expect(requiredVariables('app', ENV_REGISTRY).length).toBeGreaterThan(0);
  });
});
