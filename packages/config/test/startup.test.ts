import { describe, expect, it } from 'vitest';
import { ConfigError, ConfigErrorCode } from '../src/errors.ts';
import { Presence } from '../src/presence.ts';
import type { EnvVariable } from '../src/registry.ts';
import { ENV_REGISTRY, requiredVariables } from '../src/registry.ts';
import {
  assertEnvironment,
  checkEnvironment,
  checkNamedEnvironment,
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

/**
 * Сужение до названных имён.
 *
 * Нужно там, где процесс — часть приложения, но читает не всё, что читает
 * приложение: накат миграций открывает строку подключения и больше ничего.
 * Требовать от него остальное значит заставить того, кто накатывает схему,
 * выставить туда любое значение — то есть научить команду обходить ворота.
 */
describe('checkNamedEnvironment', () => {
  it('неназванная обязательная не проверяется, даже когда её нет', () => {
    const check = checkNamedEnvironment(['ALPHA'], { ALPHA: 'a' }, SYNTHETIC);
    expect(check.ok).toBe(true);
    expect(check.faults).toEqual([]);
  });

  it('названная обязательная без значения — изъян с её именем', () => {
    const check = checkNamedEnvironment(['ALPHA', 'BETA'], { ALPHA: 'a' }, SYNTHETIC);
    expect(check.ok).toBe(false);
    expect(check.faults.map((fault) => fault.variable)).toEqual(['BETA']);
  });

  it('пустая строка у названной — отсутствие, а не значение', () => {
    const check = checkNamedEnvironment(['ALPHA'], { ALPHA: '   ' }, SYNTHETIC);
    expect(check.ok).toBe(false);
    expect(check.faults[0]?.presence).toBe(Presence.blank);
  });

  it('названная необязательная не становится обязательной', () => {
    expect(checkNamedEnvironment(['GAMMA'], {}, SYNTHETIC).ok).toBe(true);
  });

  it('область не сужает перечень: спросили имя — проверяется имя', () => {
    // DELTA живёт в области `tooling`; названа явно — значит проверяется.
    const check = checkNamedEnvironment(['DELTA'], {}, SYNTHETIC);
    expect(check.faults.map((fault) => fault.variable)).toEqual(['DELTA']);
  });

  it('пустой перечень имён не проверяет ничего', () => {
    expect(checkNamedEnvironment([], {}, SYNTHETIC).ok).toBe(true);
  });

  it('имя, которого нет в перечне, ничего не проверяет молча', () => {
    // Отказ по несуществующему имени — забота вызывающего (`cli/check-env.ts`
    // отвергает такое имя через findEnvVariable). Здесь важно другое: выдумать
    // проверку для незнакомого имени функция не может и «всё хорошо» по
    // опечатке не отвечает — она просто не находит, что проверять.
    const check = checkNamedEnvironment(['ОПЕЧАТКА'], {}, SYNTHETIC);
    expect(check.faults).toEqual([]);
  });

  it('на живом перечне сужение до строки подключения не требует входа', () => {
    const check = checkNamedEnvironment(['SDELKA_DATABASE_URL'], {
      SDELKA_DATABASE_URL: 'postgresql://u:p@h:5432/d',
    });
    expect(check.ok).toBe(true);
    // Тот же набор без сужения обязательные переменные входа потребовал бы.
    expect(
      checkEnvironment({ SDELKA_DATABASE_URL: 'postgresql://u:p@h:5432/d' }, 'app').ok,
    ).toBe(false);
    expect(ENV_REGISTRY.some((variable) => variable.name === 'SDELKA_AUTH_MODE')).toBe(true);
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
