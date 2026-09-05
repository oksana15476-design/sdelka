import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DurationMs } from '@sdelka/domain';
import { type FxRates, type Money, isoDate, money, rational } from '@sdelka/money';
import {
  type IntakePolicy,
  IntakeError,
  IntakeErrorCode,
  PROPOSED_INTAKE_POLICY,
  allocateIncoming,
  assertMatchingWeights,
  disclosedMarkupBp,
  intakePolicyVersionId,
  marketDriftBp,
  medianShortfall,
  paymentReference,
  quote,
  referenceCheckCharacter,
  toleranceFor,
} from '../src/index';
import { NOW, gel, usd } from './support/fixtures';

/**
 * Каждая входная проверка пакета обязана иметь вход, который её роняет.
 *
 * Мутационный прогон показал, что тринадцать из девятнадцати `throw` в `src`
 * переживали полный прогон всех наборов: их не подавал ни один тест. Проверка
 * без падающего теста — не проверка, а комментарий, который компилятор не
 * читает, поэтому здесь два уровня:
 *
 *  1. **Таблица провокаций.** На каждый `throw` — вход, который его вызывает, и
 *     утверждение точного кода. Утверждать класс `IntakeError` недостаточно:
 *     соседняя проверка бросает тот же класс, и снятие проверки остаётся
 *     незамеченным.
 *  2. **Пересчёт по исходнику.** Тест читает `src`, считает места `throw` на
 *     каждый код и требует, чтобы провокаций было не меньше. Новый `throw` без
 *     теста роняет набор — это и есть то, чего не хватало.
 *
 * Недостижимые по построению места перечислены явно, с обоснованием: молчаливое
 * «здесь тест не нужен» — тот же комментарий, который никто не проверяет.
 */

interface Provocation {
  readonly code: IntakeErrorCode;
  /** Какое именно место в исходнике проверяется — чтобы таблица читалась. */
  readonly site: string;
  readonly run: () => unknown;
}

function withTolerance(overrides: Partial<IntakePolicy['tolerance']>): IntakePolicy {
  return Object.freeze({
    ...PROPOSED_INTAKE_POLICY,
    tolerance: Object.freeze({ ...PROPOSED_INTAKE_POLICY.tolerance, ...overrides }),
  });
}

/**
 * Курс с нулевым числителем через конструктор `fxRate` не собрать — он такой
 * курс отвергает. Здесь значение собрано в обход конструктора намеренно: в
 * рантайме котировка приходит из хранилища, а типы границу процесса не
 * переживают, и проверка в `disclosedMarkupBp` стоит ровно на этот случай.
 */
const ZERO_REFERENCE_RATES = {
  base: 'USD',
  quote: 'GEL',
  client: { base: 'USD', quote: 'GEL', value: rational(266n, 100n) },
  reference: { base: 'USD', quote: 'GEL', value: { numerator: 0n, denominator: 1n } },
  official: { base: 'USD', quote: 'GEL', value: rational(268n, 100n) },
} as unknown as FxRates<'USD', 'GEL'>;

/** Тот же случай для срока котировки: политика приходит из настроек, а не из литерала. */
const ZERO_VALIDITY: DurationMs = 0 as unknown as DurationMs;

const PROVOCATIONS: readonly Provocation[] = [
  {
    code: IntakeErrorCode.policyVersionInvalid,
    site: 'policy.ts intakePolicyVersionId',
    run: () => intakePolicyVersionId('2026-09-04'),
  },
  {
    code: IntakeErrorCode.amountNegative,
    site: 'tolerance.ts toleranceFor(required < 0)',
    run: () => toleranceFor(gel(-1n), PROPOSED_INTAKE_POLICY),
  },
  {
    code: IntakeErrorCode.amountNegative,
    site: 'allocation.ts assertNonNegative',
    run: () =>
      allocateIncoming({
        required: gel(-1n),
        freeBefore: gel(0n),
        incoming: gel(100n),
        tolerance: gel(0n),
        chargesBearer: 'unknown',
      }),
  },
  {
    code: IntakeErrorCode.basisPointsOutOfRange,
    site: 'tolerance.ts shareBp вне 0..10000',
    run: () => toleranceFor(gel(100_000n), withTolerance({ shareBp: 10_001 })),
  },
  {
    code: IntakeErrorCode.basisPointsOutOfRange,
    site: 'quote.ts marketDriftBp(reference = 0)',
    run: () => marketDriftBp(rational(0n, 1n), rational(2n, 1n)),
  },
  {
    code: IntakeErrorCode.basisPointsOutOfRange,
    site: 'quote.ts disclosedMarkupBp(reference = 0)',
    run: () => disclosedMarkupBp(ZERO_REFERENCE_RATES),
  },
  {
    code: IntakeErrorCode.basisPointsOutOfRange,
    site: 'matching.ts вес признака отрицателен',
    run: () =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        amountFitsPercent: -20,
        currencyMatchesPercent: 45,
      }),
  },
  {
    code: IntakeErrorCode.basisPointsOutOfRange,
    site: 'matching.ts надбавка за имя отрицательна',
    run: () =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        senderNameBonusPercent: -1,
      }),
  },
  {
    code: IntakeErrorCode.toleranceNegative,
    site: 'tolerance.ts абсолют политики отрицателен',
    run: () =>
      toleranceFor(gel(100_000n), withTolerance({ absolute: [money('GEL', -1n)], shareBp: 50 })),
  },
  {
    code: IntakeErrorCode.currencyMismatch,
    site: 'allocation.ts freeBefore в чужой валюте',
    run: () =>
      allocateIncoming({
        required: gel(100n),
        freeBefore: usd(0n) as Money<'USD'>,
        incoming: gel(100n),
        tolerance: gel(0n),
        chargesBearer: 'unknown',
      }),
  },
  {
    code: IntakeErrorCode.currencyMismatch,
    site: 'allocation.ts допуск в чужой валюте',
    run: () =>
      allocateIncoming({
        required: gel(100n),
        freeBefore: gel(0n),
        incoming: gel(100n),
        tolerance: usd(0n) as Money<'USD'>,
        chargesBearer: 'unknown',
      }),
  },
  {
    code: IntakeErrorCode.currencyMismatch,
    site: 'tracking.ts medianShortfall по разным валютам',
    run: () => medianShortfall([gel(100n), usd(100n)]),
  },
  {
    code: IntakeErrorCode.referenceAlphabet,
    site: 'reference.ts codePointOf вне алфавита',
    run: () => referenceCheckCharacter('SD-1'),
  },
  {
    code: IntakeErrorCode.referenceEmptySegment,
    site: 'reference.ts padCode на пустом коде',
    run: () => paymentReference({ dealCode: '   ', trancheCode: 'T1' }),
  },
  {
    code: IntakeErrorCode.quoteSameCurrency,
    site: 'quote.ts исходная и целевая валюта совпали',
    run: () =>
      quote(
        {
          quoteId: 'q-same',
          source: gel(1_000n),
          targetCurrency: 'GEL',
          rates: ZERO_REFERENCE_RATES as unknown as FxRates<'GEL', 'GEL'>,
          asOf: isoDate('2026-09-04'),
          issuedAt: NOW,
        },
        PROPOSED_INTAKE_POLICY,
      ),
  },
  {
    code: IntakeErrorCode.quoteTtlInvalid,
    site: 'quote.ts нулевой срок котировки',
    run: () =>
      quote(
        {
          quoteId: 'q-ttl',
          source: usd(1_000n),
          targetCurrency: 'GEL',
          rates: ZERO_REFERENCE_RATES,
          asOf: isoDate('2026-09-04'),
          issuedAt: NOW,
        },
        Object.freeze({
          ...PROPOSED_INTAKE_POLICY,
          quote: Object.freeze({ ...PROPOSED_INTAKE_POLICY.quote, validity: ZERO_VALIDITY }),
        }),
      ),
  },
  {
    code: IntakeErrorCode.weightsNotHundred,
    site: 'matching.ts сумма непарных весов не сто',
    run: () =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        amountFitsPercent: PROPOSED_INTAKE_POLICY.matching.weights.amountFitsPercent + 1,
      }),
  },
  {
    code: IntakeErrorCode.weightsNotHundred,
    site: 'matching.ts вес искажённого референса выше точного',
    run: () =>
      assertMatchingWeights({
        ...PROPOSED_INTAKE_POLICY.matching.weights,
        referenceDamagedPercent: PROPOSED_INTAKE_POLICY.matching.weights.referenceExactPercent + 1,
      }),
  },
];

/**
 * Места, куда вход не доходит по построению. Каждое — с обоснованием: список
 * без обоснования превращается в место, куда прячут непокрытое.
 */
const UNREACHABLE: Readonly<Record<string, { readonly sites: number; readonly why: string }>> =
  Object.freeze({
    [IntakeErrorCode.referenceAlphabet]: {
      sites: 1,
      why:
        'reference.ts: контрольный знак — остаток по модулю 36, а в алфавите ровно 36 знаков, ' +
        'поэтому ALPHABET[check] не бывает undefined. Ветка написана ради строгой индексации.',
    },
    [IntakeErrorCode.basisPointsOutOfRange]: {
      sites: 1,
      why:
        'matching.ts: внутри ветки above.length === 1 значение above[0] не бывает undefined. ' +
        'Ветка написана ради строгой индексации; код ошибки там взят не по смыслу.',
    },
  });

function sourceFiles(): readonly string[] {
  const directory = fileURLToPath(new URL('../src/', import.meta.url));
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(`${directory}${name}`, 'utf8'));
}

function throwSitesByCode(): ReadonlyMap<string, number> {
  const pattern = /new IntakeError\(\s*IntakeErrorCode\.(\w+)/gu;
  const counts = new Map<string, number>();
  for (const text of sourceFiles()) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const code = IntakeErrorCode[name as keyof typeof IntakeErrorCode];
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return counts;
}

describe('каждая проверка приёма роняется своим входом', () => {
  for (const provocation of PROVOCATIONS) {
    it(`${provocation.code} — ${provocation.site}`, () => {
      let thrown: unknown = null;
      try {
        provocation.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(IntakeError);
      expect((thrown as IntakeError).code).toBe(provocation.code);
    });
  }
});

describe('таблица провокаций сверена с исходником', () => {
  it('на каждое достижимое место throw есть вход, который его роняет', () => {
    const sites = throwSitesByCode();
    const provoked = new Map<string, number>();
    for (const provocation of PROVOCATIONS) {
      provoked.set(provocation.code, (provoked.get(provocation.code) ?? 0) + 1);
    }
    const shortfall: string[] = [];
    for (const [code, count] of sites) {
      const excused = UNREACHABLE[code]?.sites ?? 0;
      const required = count - excused;
      if ((provoked.get(code) ?? 0) < required) {
        shortfall.push(`${code}: мест ${count}, недостижимых ${excused}, провокаций ${provoked.get(code) ?? 0}`);
      }
    }
    expect(shortfall).toEqual([]);
  });

  it('в исходнике не осталось кода ошибки, который не бросает никто', () => {
    // Объявленный, но не бросаемый код — дверь без комнаты: тест на него
    // написать нельзя, а список кодов делает вид, что правило есть.
    const sites = throwSitesByCode();
    const orphans = Object.values(IntakeErrorCode).filter((code) => !sites.has(code));
    expect(orphans).toEqual([]);
  });

  it('таблица не ссылается на код, которого в исходнике уже нет', () => {
    const sites = throwSitesByCode();
    const stale = PROVOCATIONS.filter((item) => !sites.has(item.code)).map((item) => item.site);
    expect(stale).toEqual([]);
  });

  it('каждое недостижимое место названо и объяснено', () => {
    for (const [code, excuse] of Object.entries(UNREACHABLE)) {
      expect(throwSitesByCode().has(code)).toBe(true);
      expect(excuse.why.length).toBeGreaterThan(40);
    }
  });
});
