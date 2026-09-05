import {
  CAPABILITIES,
  CAPABILITY_SPECS,
  FACTOR_STRENGTH,
  ROLE_CAPABILITIES,
  ROLE_IDS,
  ROLE_SPECS,
  SECOND_FACTOR_KINDS,
  atLeastAsStrong,
  effectiveCapabilities,
  policyForRole,
} from '@sdelka/auth';
import { describe, expect, it } from 'vitest';
import { CODE_SQL } from './support/sql.ts';

/**
 * Справочники `0010` — построчные зеркала карт из `packages/auth`.
 *
 * Тот же приём, что у `account_kind` (`test/account-kind.test.ts`): карта
 * **спрашивается у пакета**, а не переписывается сюда, поэтому копии матрицы
 * ролей в `packages/db` нет. Расхождение здесь не косметическое: по этим
 * таблицам триггеры решают, выдавать ли грант, — строка, отставшая от кода,
 * означает либо полномочие, которое база даёт вопреки коду, либо отказ там, где
 * код разрешает.
 */
interface SeedRow {
  readonly key: string;
  readonly values: readonly string[];
}

/**
 * Строки засева справочника: `('ключ', значение, …)` до `;`.
 *
 * Читаются **все** вставки в таблицу, а не первая. Применённая миграция не
 * правится (контрольная сумма, `src/migrate.ts`), поэтому справочник, у
 * которого появилось новое значение, дописывается следующей миграцией — и
 * разборщик, видящий только первую вставку, показал бы старый список: сверка
 * упала бы на верном коде. Ошибка в сторону ложной тревоги тоже ошибка — такой
 * тест на второй раз начинают «чинить» ослаблением. Тот же довод стоит у
 * `parseEnums` про `ALTER TYPE … ADD VALUE`.
 */
function parseSeed(table: string): readonly SeedRow[] {
  const statements = [
    ...CODE_SQL.matchAll(new RegExp(`INSERT INTO sdelka\\.${table}[^;]*;`, 'gu')),
  ].map((match) => match[0]);
  expect(statements.length, `засев справочника ${table} не найден`).toBeGreaterThan(0);
  // Перечень колонок тоже в скобках, поэтому строка обязана начинаться с
  // ключа в кавычках: иначе разборщик прочитал бы заголовок как данные.
  return statements.flatMap((body) =>
    [...body.matchAll(/\(\s*'([a-z_.]+)',([^)]*)\)/gu)].map((match) => ({
      key: match[1] ?? '',
      values: (match[2] ?? '')
        .split(',')
        .map((item) => item.trim())
        .map((item) => item.replace(/^'|'$/gu, '')),
    })),
  );
}

describe('sdelka.auth_role — зеркало ROLE_SPECS', () => {
  const seed = parseSeed('auth_role');

  it('перечисляет ровно те же роли и в том же порядке', () => {
    expect(seed.map((row) => row.key)).toEqual([...ROLE_IDS]);
  });

  for (const roleId of ROLE_IDS) {
    it(`${roleId} — аудитория и право дежурства совпадают`, () => {
      const row = seed.find((item) => item.key === roleId);
      expect(row, roleId).toBeDefined();
      expect(row?.values).toEqual([
        ROLE_SPECS[roleId].audience,
        String(ROLE_SPECS[roleId].dutyEligible),
      ]);
    });
  }

  it('право дежурства есть ровно у трёх ролей', () => {
    // `ACTORS.md` §7.1: дежурство — режим поверх ОП, ФК и РО, и больше ни
    // поверх чего. Четвёртая строка означала бы дежурство у роли, которой оно
    // добавляет полномочия, не предусмотренные документом.
    const eligible = seed.filter((row) => row.values[1] === 'true').map((row) => row.key);
    expect(eligible).toEqual(
      ROLE_IDS.filter((roleId) => ROLE_SPECS[roleId].dutyEligible).map(String),
    );
    expect(eligible).toHaveLength(3);
  });
});

describe('sdelka.session_policy — зеркало политик сессии', () => {
  const seed = parseSeed('session_policy');

  it('перечисляет ровно те аудитории, которые встречаются у ролей', () => {
    const audiences = new Set(ROLE_IDS.map((roleId) => ROLE_SPECS[roleId].audience));
    expect(seed.map((row) => row.key).sort()).toEqual([...audiences].sort());
  });

  for (const roleId of ROLE_IDS) {
    const audience = ROLE_SPECS[roleId].audience;
    it(`${audience} (по роли ${roleId}) — сроки и требование фактора совпадают`, () => {
      const policy = policyForRole(roleId);
      const row = seed.find((item) => item.key === audience);
      expect(row, audience).toBeDefined();
      expect(row?.values).toEqual([
        String(policy.maxTtl),
        String(policy.idleTtl),
        String(policy.stepUpMaxAge),
        policy.minimumFactorStrength,
        String(policy.secondFactorAtLogin),
      ]);
    });
  }
});

describe('sdelka.second_factor и sdelka.factor_strength_rank', () => {
  const factors = parseSeed('second_factor');
  const ranks = parseSeed('factor_strength_rank');

  it('перечисляет ровно те же виды фактора и в том же порядке', () => {
    expect(factors.map((row) => row.key)).toEqual([...SECOND_FACTOR_KINDS]);
  });

  for (const kind of SECOND_FACTOR_KINDS) {
    it(`${kind} — устойчивость совпадает с FACTOR_STRENGTH`, () => {
      expect(factors.find((row) => row.key === kind)?.values).toEqual([FACTOR_STRENGTH[kind]]);
    });
  }

  it('порядок строгости в базе даёт те же ответы, что atLeastAsStrong', () => {
    // `STRENGTH_ORDER` из пакета не экспортирован, и сверять числа не с чем.
    // Сверяется поэтому **поведение**: ранг существует ради одного вопроса —
    // «достаточно ли силён фактор», и на этот вопрос база обязана отвечать так
    // же, как код. Иначе код в SMS однажды сойдёт за ключ.
    const rank = new Map(ranks.map((row) => [row.key, Number(row.values[0])]));
    expect(rank.size).toBeGreaterThan(0);
    for (const kind of SECOND_FACTOR_KINDS) {
      for (const minimum of new Set(Object.values(FACTOR_STRENGTH))) {
        const byRank = (rank.get(FACTOR_STRENGTH[kind]) ?? -1) >= (rank.get(minimum) ?? -1);
        expect(byRank, `${kind} >= ${minimum}`).toBe(atLeastAsStrong(kind, minimum));
      }
    }
  });
});

describe('sdelka.auth_capability — зеркало CAPABILITY_SPECS', () => {
  const seed = parseSeed('auth_capability');

  it('перечисляет ровно те же полномочия и в том же порядке', () => {
    expect(seed.map((row) => row.key)).toEqual([...CAPABILITIES]);
  });

  for (const capability of CAPABILITIES) {
    it(`${capability} — класс действия, второй фактор и журналирование совпадают`, () => {
      const spec = CAPABILITY_SPECS[capability];
      expect(seed.find((row) => row.key === capability)?.values).toEqual([
        spec.effect,
        spec.secondFactor,
        String(spec.journaled),
      ]);
    });
  }
});

describe('sdelka.role_capability — зеркало ROLE_CAPABILITIES и дежурства', () => {
  const seed = parseSeed('role_capability');

  /** `роль:полномочие` → требует ли дежурства. */
  const stored = new Map(seed.map((row) => [`${row.key}:${row.values[0]}`, row.values[1]]));

  it('строк ровно столько, сколько пар в карте полномочий', () => {
    expect(stored.size).toBe(seed.length);
  });

  for (const roleId of ROLE_IDS) {
    it(`${roleId} — базовые полномочия совпадают`, () => {
      const base = seed
        .filter((row) => row.key === roleId && row.values[1] === 'false')
        .map((row) => row.values[0]);
      expect(base).toEqual([...ROLE_CAPABILITIES[roleId]]);
    });

    it(`${roleId} — полномочия дежурства совпадают с effectiveCapabilities`, () => {
      // Дежурство **добавляет** и не убирает ничего (§7.1 п.2), а флаг сам по
      // себе полномочий не даёт: у роли без права дежурства прибавки нет.
      const added = effectiveCapabilities(roleId, true).filter(
        (capability) => !ROLE_CAPABILITIES[roleId].includes(capability),
      );
      const duty = seed
        .filter((row) => row.key === roleId && row.values[1] === 'true')
        .map((row) => row.values[0]);
      expect(duty).toEqual([...added]);
    });
  }

  it('manage_access не выдан ни одной роли', () => {
    // `capabilities.ts`: полномочия нет в `ACTORS.md` §5.1, и «полномочие,
    // которого нет, — это либо „может кто угодно“, либо „не может никто“».
    // Взято второе, и в базе оно выражается отсутствием строки: грант отвергнет
    // внешний ключ, а не проверка в коде приложения.
    expect([...stored.keys()].filter((key) => key.endsWith(':manage_access'))).toEqual([]);
  });

  it('ни одной пары сверх карты пакета', () => {
    const expected = new Set<string>();
    for (const roleId of ROLE_IDS) {
      for (const capability of effectiveCapabilities(roleId, true)) {
        expected.add(`${roleId}:${capability}`);
      }
    }
    expect([...stored.keys()].filter((key) => !expected.has(key))).toEqual([]);
  });
});

describe('секретов в схеме нет места', () => {
  /**
   * Красная линия №12 в применении к схеме: пароль, семя TOTP, одноразовый код
   * и приватный ключ не хранятся **никак** — ни в открытом виде, ни в
   * необратимом. Основание — устройство пакета: подтверждение выдаёт порт, а
   * реестр отвечает только на вопрос «привязан ли фактор»
   * (`SecondFactorRegistryPort`).
   *
   * Тест смотрит на имена колонок: колонку заводят раньше, чем начинают в неё
   * писать, и поймать это надо в тот момент.
   */
  const FORBIDDEN = [
    'password',
    'password_hash',
    'passphrase',
    'secret',
    'secret_hash',
    'totp_secret',
    'otp',
    'otp_code',
    'pin',
    'private_key',
    'token',
    'access_token',
    'refresh_token',
    'verifier',
    'credential',
    'seed',
  ];

  const columns = [...CODE_SQL.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s+[a-z]/gmu)].map(
    (item) => item[1] ?? '',
  );

  it('колонки вообще нашлись', () => {
    expect(columns.length).toBeGreaterThan(20);
  });

  for (const forbidden of FORBIDDEN) {
    it(`нет колонки ${forbidden}`, () => {
      expect(columns).not.toContain(forbidden);
    });
  }

  it('ни одна колонка не похожа на хранилище секрета', () => {
    // «Ключ» сам по себе не подозрителен: `account_key`, `idempotency_key` и
    // `source_key` — непрозрачные идентификаторы, а не материал. Подозрителен
    // ключ **именованный как материал**: приватный, секретный, подписи.
    const suspicious = columns.filter(
      (name) =>
        /(^|_)(password|passphrase|secret|token|otp|pin|credential|verifier|seed)(_|$)/u.test(
          name,
        ) || /(private|secret|api|signing|encryption)_key|key_material/u.test(name),
    );
    expect(suspicious).toEqual([]);
  });
});
