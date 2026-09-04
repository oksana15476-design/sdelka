import {
  AUDIT_RECORD_KINDS,
  AUDIT_ROLES,
  FINGERPRINT_SUBJECTS,
  RAW_SOURCE_KINDS,
  REF_SCOPES,
} from '@sdelka/audit';
import {
  AUTH_EVENT_KINDS,
  AUTH_REASON_KEYS,
  CAPABILITIES,
  CAPABILITY_SPECS,
  FACTOR_STRENGTH,
  PRIMARY_METHODS,
  ROLE_IDS,
  ROLE_SPECS,
  SECOND_FACTOR_KINDS,
} from '@sdelka/auth';
import {
  BENEFICIARY_STATUSES,
  DEAL_STATUSES,
  FILING_SOURCES,
  FREEZABLE_TRANCHE_STATUSES,
  FREEZE_REASONS,
  OBSERVATION_LEVELS,
  OWNER_CHECKS,
  PAYOUT_STATUSES,
  RELEASE_CONDITION_TYPES,
  TERMINAL_TRANCHE_STATUSES,
  TERMINAL_WITHDRAWAL_STATUSES,
  TRANCHE_STATUSES,
  WITHDRAWAL_STATUSES,
} from '@sdelka/domain';
import { ACTIVE_PAYOUT_STATUSES } from '@sdelka/domain';
import { CURRENCY_CODES, CURRENCY_EXPONENT } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_KINDS } from '../src/accounts.ts';
import {
  CODE_SQL,
  MIGRATIONS,
  constraintStatuses,
  parseEnums,
  partialIndexStatuses,
} from './support/sql.ts';

/**
 * Дрейф перечней между TS и SQL.
 *
 * Перечень, переписанный в базу руками, расходится с оригиналом молча: значение
 * добавили в TS, забыли в SQL, и ограничение начинает отвергать законное
 * состояние — или, что хуже, перестаёт отвергать незаконное. Тест ловит это без
 * базы, поэтому падает у всех, а не у того, у кого поднят кластер.
 */
const ENUMS = parseEnums(CODE_SQL);

function enumValues(name: string): readonly string[] {
  const values = ENUMS.get(name);
  expect(values, `перечень sdelka.${name} не найден в миграциях`).toBeDefined();
  return values ?? [];
}

describe('перечни базы — построчное зеркало массивов из TS', () => {
  const cases: readonly [string, readonly string[]][] = [
    ['tranche_status', TRANCHE_STATUSES],
    ['deal_status', DEAL_STATUSES],
    ['payout_status', PAYOUT_STATUSES],
    ['withdrawal_status', WITHDRAWAL_STATUSES],
    ['release_condition_type', RELEASE_CONDITION_TYPES],
    ['freeze_reason', FREEZE_REASONS],
    ['beneficiary_status', BENEFICIARY_STATUSES],
    ['observation_level', OBSERVATION_LEVELS],
    ['owner_check', OWNER_CHECKS],
    ['filing_source', FILING_SOURCES],
    ['audit_record_kind', AUDIT_RECORD_KINDS],
    ['audit_role', AUDIT_ROLES],
    ['raw_source_kind', RAW_SOURCE_KINDS],
    ['fingerprint_subject', FINGERPRINT_SUBJECTS],
    ['ref_scope', REF_SCOPES],
    ['account_kind_code', ACCOUNT_KINDS],
    // packages/auth: хранилища у пакета нет, перечни есть. Значение, добавленное
    // в роль или полномочие и не доехавшее до `0010`, — это либо запрет, который
    // база пропускает, либо разрешение, которое она отвергает.
    ['role_id', ROLE_IDS],
    ['capability', CAPABILITIES],
    ['second_factor_kind', SECOND_FACTOR_KINDS],
    ['auth_primary_method', PRIMARY_METHODS],
    ['auth_event_kind', AUTH_EVENT_KINDS],
    ['auth_reason_key', Object.values(AUTH_REASON_KEYS)],
  ];

  for (const [name, expected] of cases) {
    it(`sdelka.${name}`, () => {
      // Порядок тоже сверяется: метки перечня в Postgres упорядочены, и порядок
      // виден в `ORDER BY`. Разошедшийся порядок — это тихо разошедшаяся
      // сортировка в отчёте дежурному.
      expect(enumValues(name)).toEqual([...expected]);
    });
  }

  /**
   * Перечни, у которых в TS нет массива, — только объединение типов. Сверяются
   * по множеству значений, использованных картами: метка, которой не
   * пользуется ни одна запись карты, и значение карты, которого нет в перечне,
   * одинаково означают расхождение.
   */
  const derived: readonly [string, readonly string[]][] = [
    ['role_audience', ROLE_IDS.map((role) => ROLE_SPECS[role].audience)],
    ['capability_effect', CAPABILITIES.map((item) => CAPABILITY_SPECS[item].effect)],
    [
      'second_factor_requirement',
      CAPABILITIES.map((item) => CAPABILITY_SPECS[item].secondFactor),
    ],
    ['factor_strength', SECOND_FACTOR_KINDS.map((kind) => FACTOR_STRENGTH[kind])],
  ];

  for (const [name, used] of derived) {
    it(`sdelka.${name} — множество совпадает с использованным в TS`, () => {
      expect([...enumValues(name)].sort()).toEqual([...new Set(used)].sort());
    });
  }

  it('справочник валют — зеркало CURRENCY_EXPONENT, включая JPY', () => {
    const rows = [
      ...CODE_SQL.matchAll(/\('([A-Z]{3})',\s*(\d)\)/gu),
    ].map((match) => [match[1], Number(match[2])] as const);
    const seeded = new Map(rows);
    expect([...seeded.keys()].sort()).toEqual([...CURRENCY_CODES].sort());
    for (const code of CURRENCY_CODES) {
      expect(seeded.get(code)).toBe(CURRENCY_EXPONENT[code]);
    }
    // JPY с нулём знаков держится намеренно: он ловит захардкоженную сотню.
    expect(seeded.get('JPY')).toBe(0);
  });
});

describe('предикаты, выведенные из перечней', () => {
  it('частичный индекс выплат перечисляет ровно ACTIVE_PAYOUT_STATUSES', () => {
    // Инвариант 9. `unknown` в списке обязателен: деньги, возможно, ушли
    // (`STATE-MACHINES.md` §2.2), и вторая выплата по тому же траншу в этот
    // момент — двойная выплата.
    expect(partialIndexStatuses(CODE_SQL, 'payout_one_active_per_tranche')).toEqual([
      ...ACTIVE_PAYOUT_STATUSES,
    ]);
  });

  it('частичный индекс выводов перечисляет нетерминальные статусы', () => {
    const expected = WITHDRAWAL_STATUSES.filter(
      (status) => !(TERMINAL_WITHDRAWAL_STATUSES as readonly string[]).includes(status),
    );
    expect(partialIndexStatuses(CODE_SQL, 'withdrawal_one_active_per_party')).toEqual([
      ...expected,
    ]);
  });

  it('источник заморозки — ровно FREEZABLE_TRANCHE_STATUSES', () => {
    expect(constraintStatuses(CODE_SQL, 'tranche_freezable_origin')).toEqual([
      ...FREEZABLE_TRANCHE_STATUSES,
    ]);
  });

  it('терминальная ветвь ограничения состояния — ровно TERMINAL_TRANCHE_STATUSES', () => {
    const match = /WHEN status IN \(([^)]*)\) THEN\n\s*deadline_at IS NULL AND entered_at IS NULL/u
      .exec(CODE_SQL);
    const listed = [...(match?.[1] ?? '').matchAll(/'([^']*)'/gu)].map((item) => item[1] ?? '');
    expect(listed).toEqual([...TERMINAL_TRANCHE_STATUSES]);
  });
});

describe('форма миграций', () => {
  it('каждая миграция после первой выполняется от имени владельца схемы', () => {
    // Иначе объекты достанутся тому, кто случайно подключился, и гранты роли
    // приложения (инвариант 21) перестанут что-либо значить.
    for (const migration of MIGRATIONS) {
      expect(migration.sql, migration.fileName).toContain('SET LOCAL ROLE sdelka_owner;');
    }
  });

  it('ни одна регулярка не выходит за предел счётчика повторений Postgres', () => {
    // POSIX-регулярка Postgres не принимает счётчик больше 255, и выражение с
    // большим счётчиком **компилируется молча**: ограничение создаётся, а
    // падает первая же вставка. Один раз это уже стоило половины набора.
    const counts = [...CODE_SQL.matchAll(/\{(\d+),(\d+)\}/gu)].map(
      (item) => Number(item[2] ?? '0'),
    );
    expect(counts.filter((value) => value > 255)).toEqual([]);
  });

  it('нумерация миграций сплошная и начинается с 0001', () => {
    expect(MIGRATIONS.map((item) => item.version)).toEqual(
      MIGRATIONS.map((_, index) => String(index + 1).padStart(4, '0')),
    );
  });
});
