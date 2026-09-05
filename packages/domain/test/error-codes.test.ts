import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { money, rational } from '@sdelka/money';
import {
  type ObservationLevel,
  type OwnerCheck,
  type ReleaseConditionType,
  DomainError,
  RejectionCode,
  assertWithholdingWithinCeiling,
  deadline,
  duration,
  feeCeilingPolicy,
  instant,
  maxWithholding,
  nonTerminalTrancheState,
  releaseObservation,
  uuid5,
} from '../src/index';
import { CADASTRAL_CODE, NOW, RAW_DIGEST, observation } from './support/facts';

/**
 * Каждый `throw` домена обязан иметь вход, который его роняет.
 *
 * У `DomainError` два опознавательных знака: код отказа и **деталь** —
 * второй аргумент конструктора. Шесть проверок конструктора наблюдения бросают
 * один и тот же код `observation.invalid` и различаются только деталью
 * (`level`, `sourceKey`, `cadastralCode`…). Мутационный прогон показал, чем это
 * кончается: снятие трёх из шести не роняло ни одного теста во всём дереве —
 * соседняя проверка ловила тот же вход и утверждение о коде оставалось истинным.
 *
 * Поэтому таблица ниже держит пару «код + деталь», а сторож в конце сверяет её с
 * исходником: новая проверка без провокации роняет набор.
 */

interface Provocation {
  readonly code: RejectionCode;
  /** Второй аргумент `DomainError`. `null` — деталь не литерал (переменная) либо её нет. */
  readonly detail: string | null;
  readonly site: string;
  readonly run: () => unknown;
}

function badObservation(overrides: Record<string, unknown>): () => unknown {
  return () => releaseObservation({ ...observation(), ...overrides } as never);
}

const PROVOCATIONS: readonly Provocation[] = [
  {
    code: RejectionCode.feeCeilingInvalid,
    detail: 'out_of_range',
    site: 'tariff.ts feeCeilingPolicy — доля вне [0, 1]',
    run: () => feeCeilingPolicy(rational(3n, 2n)),
  },
  {
    code: RejectionCode.feeCeilingInvalid,
    detail: 'negative_gross',
    site: 'tariff.ts maxWithholding — отрицательная сумма',
    run: () => maxWithholding(money('GEL', -1n)),
  },
  {
    code: RejectionCode.feeExceedsCeiling,
    detail: 'withholding',
    site: 'tariff.ts assertWithholdingWithinCeiling — удержание выше потолка',
    run: () => assertWithholdingWithinCeiling(money('GEL', 100_000n), money('GEL', 99_000n)),
  },
  {
    code: RejectionCode.invalidUuid,
    detail: null,
    site: 'ids.ts uuid5 — пространство имён не uuid',
    run: () => uuid5('не-uuid', 'tranche-1'),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'level',
    site: 'observation.ts уровень вне перечня',
    run: badObservation({ level: 'L9' as ObservationLevel }),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'conditionType',
    site: 'observation.ts тип условия вне перечня',
    run: badObservation({ conditionType: 'moon_phase' as ReleaseConditionType }),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'ownerCheck',
    site: 'observation.ts вердикт о собственнике вне перечня',
    run: badObservation({ ownerCheck: 'probably' as OwnerCheck }),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'sourceKey',
    site: 'observation.ts наблюдение без источника',
    run: badObservation({ sourceKey: '' }),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'cadastralCode',
    site: 'observation.ts наблюдение без объекта',
    run: badObservation({ cadastralCode: '' }),
  },
  {
    code: RejectionCode.observationInvalid,
    detail: 'rawSourceDigest',
    site: 'observation.ts наблюдение без отпечатка сырого ответа',
    run: badObservation({ rawSourceDigest: 'not-a-digest' }),
  },
  {
    code: RejectionCode.conditionActMissing,
    detail: null,
    site: 'tranche.ts assertConditionAct — состояние после pending без акта',
    run: () => nonTerminalTrancheState('collected', deadline(instant(NOW + 1_000)), NOW, null),
  },
  {
    code: RejectionCode.invalidInstant,
    detail: null,
    site: 'instant.ts момент времени не целый',
    run: () => instant(1.5),
  },
  {
    code: RejectionCode.invalidInstant,
    detail: null,
    site: 'instant.ts длительность не положительна',
    run: () => duration(0),
  },
];

/**
 * Места, куда вход не доходит по построению. Каждое — с обоснованием.
 */
const UNREACHABLE: readonly { readonly code: string; readonly detail: string | null; readonly why: string }[] = [
  {
    code: RejectionCode.invalidUuid,
    detail: null,
    why:
      'ids.ts uuid5: `digest` — срез первых шестнадцати байтов SHA-1, поэтому байты 6 и 8 в нём ' +
      'всегда есть. Ветка написана ради строгой индексации, входа, который её роняет, не бывает.',
  },
  {
    code: RejectionCode.conditionActMissing,
    detail: 'paid_out',
    why:
      'tranche.ts entryIntents(paid_out): оба ребра в `paid_out` несут guard`ы g_evidence_present ' +
      'и g_funds_collected, читающие ровно те же поля фактов, а акт привязан к траншу на выходе ' +
      'из `pending`. Ветка написана исключением намеренно — деньги к этой секунде уже ушли, — но ' +
      'редьюсер до неё не доходит: это второй рубеж, а не проверка входа.',
  },
];

function sourceTexts(): readonly string[] {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  return readdirSync(root)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(`${root}${name}`, 'utf8'));
}

/** Ключ места: код плюс деталь-литерал. Деталь-переменная считается за `null`. */
function throwSites(): ReadonlyMap<string, number> {
  const pattern = /new DomainError\(\s*RejectionCode\.(\w+)(?:,\s*(?:'([^']*)')?)?/gu;
  const counts = new Map<string, number>();
  for (const text of sourceTexts()) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const code = RejectionCode[name as keyof typeof RejectionCode];
      const key = `${code}|${match[2] ?? ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe('каждая проверка домена роняется своим входом', () => {
  for (const provocation of PROVOCATIONS) {
    it(`${provocation.code}${provocation.detail === null ? '' : `/${provocation.detail}`} — ${provocation.site}`, () => {
      let thrown: unknown = null;
      try {
        provocation.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).code).toBe(provocation.code);
      if (provocation.detail !== null) {
        // Деталь — единственное, чем шесть проверок наблюдения отличаются друг
        // от друга. Без неё утверждение проходит и при снятой проверке.
        expect((thrown as DomainError).message).toBe(provocation.detail);
      }
    });
  }
});

describe('таблица провокаций сверена с исходником', () => {
  it('на каждое достижимое место throw есть вход, который его роняет', () => {
    const sites = throwSites();
    const excused = new Map<string, number>();
    for (const item of UNREACHABLE) {
      const key = `${item.code}|${item.detail ?? ''}`;
      excused.set(key, (excused.get(key) ?? 0) + 1);
    }
    const provoked = new Map<string, number>();
    for (const item of PROVOCATIONS) {
      const key = `${item.code}|${item.detail ?? ''}`;
      provoked.set(key, (provoked.get(key) ?? 0) + 1);
    }
    const gaps: string[] = [];
    for (const [key, count] of sites) {
      const required = count - (excused.get(key) ?? 0);
      if ((provoked.get(key) ?? 0) < required) {
        gaps.push(`${key}: мест ${count}, недостижимых ${excused.get(key) ?? 0}, провокаций ${provoked.get(key) ?? 0}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('таблица не ссылается на место, которого в исходнике уже нет', () => {
    const sites = throwSites();
    const stale = PROVOCATIONS.filter(
      (item) => !sites.has(`${item.code}|${item.detail ?? ''}`),
    ).map((item) => item.site);
    expect(stale).toEqual([]);
  });

  it('каждое недостижимое место названо, объяснено и существует', () => {
    const sites = throwSites();
    for (const item of UNREACHABLE) {
      expect(sites.has(`${item.code}|${item.detail ?? ''}`)).toBe(true);
      expect(item.why.length).toBeGreaterThan(80);
    }
  });

  it('сторож видит исходник, а не пустоту', () => {
    expect(throwSites().size).toBeGreaterThan(5);
  });
});

describe('крайние величины времени и длительности', () => {
  it('момент — целое число миллисекунд, ноль законен', () => {
    expect(instant(0)).toBe(0);
    expect(() => instant(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => instant(Number.NaN)).toThrow(DomainError);
    expect(() => instant(Number.POSITIVE_INFINITY)).toThrow(DomainError);
  });

  it('длительность строго положительна: нулевой срок — не срок', () => {
    // Ноль и отрицательная длительность прошли бы всю арифметику дедлайнов
    // молча: `plus(at, 0)` даёт тот же момент, и «нетерминальное состояние без
    // срока» стало бы выразимым в обход инварианта 7.
    expect(() => duration(1)).not.toThrow();
    expect(() => duration(0)).toThrow(DomainError);
    expect(() => duration(-1)).toThrow(DomainError);
    expect(() => duration(1.5)).toThrow(DomainError);
  });

  it('наблюдение с законными значениями по-прежнему собирается', () => {
    // Обратная сторона таблицы отказов: проверки не запрещают правильный вход.
    const value = observation({ cadastralCode: CADASTRAL_CODE, rawSourceDigest: RAW_DIGEST });
    expect(value.cadastralCode).toBe(CADASTRAL_CODE);
    expect(value.rawSourceDigest).toBe(RAW_DIGEST);
  });
});
