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
  PAYOUT_LEGS,
  PAYOUT_STATUSES,
  RELEASE_CONDITION_TYPES,
  TERMINAL_PAYOUT_STATUSES,
  TERMINAL_TRANCHE_STATUSES,
  TERMINAL_WITHDRAWAL_STATUSES,
  TRANCHE_STATUSES,
  UNFREEZE_TARGETS,
  WITHDRAWAL_STATUSES,
  isUsableReleaseCondition,
} from '@sdelka/domain';
import { ACTIVE_PAYOUT_STATUSES } from '@sdelka/domain';
import {
  ACCOUNT_TYPES,
  DIRECTIONS,
  FUNDS_FILE_SCOPES,
  FUNDS_OWNERSHIPS,
  JOURNAL_ENTRY_KINDS,
  POOL_DIRECTIONS,
  PLATFORM_FUNDS_ROLES,
  STOP_ACCEPTING_INVARIANT_CODES,
} from '@sdelka/ledger';
import { CURRENCY_CODES, CURRENCY_EXPONENT } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_KINDS } from '../src/accounts.ts';
import {
  CODE_SQL,
  MIGRATIONS,
  constraintStatuses,
  constraintValues,
  parseEnums,
  partialIndexStatuses,
  viewValues,
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
    // packages/ledger: природа счёта и форма проводки. Массивами, а не типами,
    // они стали ровно ради этой сверки — сверять значение с типом нечем.
    ['direction', DIRECTIONS],
    ['journal_entry_kind', JOURNAL_ENTRY_KINDS],
    ['account_type', ACCOUNT_TYPES],
    ['funds_ownership', FUNDS_OWNERSHIPS],
    ['platform_funds_role', PLATFORM_FUNDS_ROLES],
    ['funds_file_scope', FUNDS_FILE_SCOPES],
    ['pool_direction', POOL_DIRECTIONS],
    ['tranche_status', TRANCHE_STATUSES],
    ['deal_status', DEAL_STATUSES],
    ['payout_status', PAYOUT_STATUSES],
    ['withdrawal_status', WITHDRAWAL_STATUSES],
    ['payout_leg', PAYOUT_LEGS],
    ['release_condition_type', RELEASE_CONDITION_TYPES],
    ['freeze_reason', FREEZE_REASONS],
    // Перечень, которым пока не пользуется ни одна колонка схемы (`0001`), и
    // это **не повод не сторожить его**: разошедшись молча, он подведёт в тот
    // день, когда колонка появится, — то есть в день, когда разбираться будет
    // некогда. Что дверь стоит без дороги, сказано отдельным тестом ниже.
    ['unfreeze_target', UNFREEZE_TARGETS],
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

  it('у каждого перечня базы есть сторож', () => {
    /**
     * Перечень, не попавший ни в один случай выше, — это дверь без сторожа.
     *
     * Ровно так и вышло с `sdelka.unfreeze_target`: он объявлен в `0001`, у
     * него есть экспортированный массив в TS (`UNFREEZE_TARGETS`), и при этом
     * его не было ни в одном случае — расходиться он мог сколько угодно и
     * молча. Список случаев, который надо не забыть пополнить, забывают
     * всегда; поэтому здесь стоит обратная проверка: новый перечень в SQL
     * роняет тест, пока ему не назначен сторож.
     */
    const guarded = new Set([...cases, ...derived].map(([name]) => name));
    expect([...ENUMS.keys()].filter((name) => !guarded.has(name))).toEqual([]);
    // И обратно: случай, ссылающийся на перечень, которого в SQL нет, —
    // сверка, которая всегда проходит.
    expect([...guarded].filter((name) => !ENUMS.has(name))).toEqual([]);
  });

  it('unfreeze_target: перечень есть, колонки под него нет', () => {
    // **[открыто]** Целевое состояние разморозки — явное поле решения двух
    // людей (И9.2), и в TS оно есть (`UnfreezeTarget`), а в схеме под него не
    // заведено ни одной колонки: заморозка хранится в `sdelka.tranche`
    // (`suspended_from`, `freeze_reason`, `frozen_by`), решение о выходе —
    // нигде. Тест фиксирует известное состояние, чтобы оно не выглядело
    // недосмотром: появится колонка — эта строка упадёт и будет снята вместе с
    // ответом на вопрос, где живёт решение о разморозке.
    const columns = [...CODE_SQL.matchAll(/sdelka\.unfreeze_target/gu)];
    expect(columns.length, 'перечень объявлен ровно один раз и больше нигде').toBe(1);
  });

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

  it('часы заявки есть ровно у нетерминальных статусов', () => {
    // `withdrawal_state_shape` (`0022`) — зеркало союза `WithdrawalState`:
    // терминальная заявка часов не носит, нетерминальная без них не существует
    // (`DECISIONS-REVIEW.md` §H4). Перечень в SQL написан строками — здесь он не
    // даёт разойтись с перечнем домена.
    expect(constraintValues(CODE_SQL, 'withdrawal_state_shape')).toEqual([
      ...TERMINAL_WITHDRAWAL_STATUSES,
    ]);
    // Индекс возраста покрывает ровно те статусы, у которых возраст есть: по
    // нему идёт эскалация застрявшей заявки, и статус, выпавший из индекса,
    // выпал бы и из очереди разбора.
    expect(partialIndexStatuses(CODE_SQL, 'withdrawal_stalled')).toEqual([
      ...WITHDRAWAL_STATUSES.filter(
        (status) => !(TERMINAL_WITHDRAWAL_STATUSES as readonly string[]).includes(status),
      ),
    ]);
  });

  it('источник заморозки — ровно FREEZABLE_TRANCHE_STATUSES', () => {
    expect(constraintStatuses(CODE_SQL, 'tranche_freezable_origin')).toEqual([
      ...FREEZABLE_TRANCHE_STATUSES,
    ]);
  });

  it('годный тип условия — ровно isUsableReleaseCondition', () => {
    // Ограничение `condition_act_usable_type` названо в `0004` зеркалом
    // доменной функции, а зеркалило половину: SQL отвергал один
    // `registration_preliminary`, функция — **два** значения, потому что
    // требует `!requiresConfirmation` И `sourceImplemented`. Акт с
    // `calendar_date` вставлялся, то есть транш законно открывал приём средств
    // под условие, по которому расчёт невозможен никогда. `0015` дописал
    // список, а эта строка не даёт ему разойтись снова.
    expect(constraintValues(CODE_SQL, 'condition_act_usable_type')).toEqual(
      RELEASE_CONDITION_TYPES.filter(isUsableReleaseCondition),
    );
  });

  it('ссылка на ответ провайдера — ровно TERMINAL_PAYOUT_STATUSES', () => {
    // Ответа провайдера до ответа провайдера не бывает: ссылка возможна только
    // там, где перевод уже получил исход. Обязательной она при этом не
    // является нигде — терминальное состояние достигается и сверкой по
    // выписке, где ответа нет по построению (`0018`).
    expect(constraintValues(CODE_SQL, 'payout_response_only_when_answered')).toEqual([
      ...TERMINAL_PAYOUT_STATUSES,
    ]);
  });

  it('стоп-кран базы перечисляет ровно STOP_ACCEPTING_INVARIANT_CODES', () => {
    // Два списка одних и тех же пяти кодов — в `v_should_stop_accepting_deals`
    // и в `shouldStopAcceptingDeals` — совпадали только потому, что их писали в
    // один день. Разойдясь, они дали бы стоп-кран, который срабатывает в одном
    // контуре и молчит в другом: приём новых сделок остановлен по журналу и не
    // остановлен по базе (или наоборот). Сверять их стало чем только после
    // того, как условие в TS стало значением.
    expect(viewValues(CODE_SQL, 'v_should_stop_accepting_deals')).toEqual([
      ...STOP_ACCEPTING_INVARIANT_CODES,
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
