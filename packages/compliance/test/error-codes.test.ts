import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type PayerRelationship,
  ComplianceError,
  ComplianceErrorCode,
  DEFAULT_NAME_FEATURE_WEIGHTS,
  SUPPORT_ROLE,
  actor,
  assessPayer,
  authorize,
  compareNames,
  combineFeatures,
  countryCode,
  documentNumberFingerprint,
  dualControlRequirement,
  evaluateConcentration,
  nameObservation,
  policyVersionId,
} from '../src/index';
import { BUYER_DOCUMENT, BUYER_NAMES, GE, NOW, OTHER_DOCUMENT, OTHER_NAMES, POLICY } from './support/fixtures';

/**
 * Каждая входная проверка пакета обязана иметь вход, который её роняет.
 *
 * Форма и обоснование — те же, что в `@sdelka/intake`: мутационный прогон
 * показал, что часть `throw` в `src` переживала полный прогон всех наборов, то
 * есть их не подавал ни один тест. Здесь два уровня: таблица провокаций с
 * утверждением **точного кода** (класс `ComplianceError` бросают все проверки
 * подряд, и на нём снятие соседней проверки не видно) и пересчёт мест `throw`
 * по исходнику.
 */

interface Provocation {
  readonly code: ComplianceErrorCode;
  readonly site: string;
  readonly run: () => unknown;
}

const PROVOCATIONS: readonly Provocation[] = [
  {
    code: ComplianceErrorCode.fingerprintInvalid,
    site: 'pii.ts checked — не шестнадцатеричный отпечаток',
    run: () => documentNumberFingerprint('не отпечаток'),
  },
  {
    code: ComplianceErrorCode.countryCodeInvalid,
    site: 'identity.ts countryCode',
    run: () => countryCode('Грузия'),
  },
  {
    code: ComplianceErrorCode.basisPointsOutOfRange,
    site: 'names.ts вес доказательства вне 0..10000',
    run: () =>
      nameObservation({
        alphabet: 'latin',
        given: 'ANA',
        family: 'BERIDZE',
        source: 'identity_document',
        evidenceWeightBp: 10_001,
      }),
  },
  {
    code: ComplianceErrorCode.basisPointsOutOfRange,
    site: 'names.ts combineFeatures — сумма весов ансамбля не сто',
    run: () =>
      combineFeatures(
        { levenshteinBp: 10_000, trigramBp: 10_000, jaroWinklerBp: 10_000 },
        { ...DEFAULT_NAME_FEATURE_WEIGHTS, trigramPercent: 31 },
      ),
  },
  {
    code: ComplianceErrorCode.nameObservationEmpty,
    site: 'names.ts наблюдение без имени и фамилии',
    run: () =>
      nameObservation({
        alphabet: 'latin',
        given: '  ',
        family: '',
        source: 'client_declared',
        evidenceWeightBp: 5_000,
      }),
  },
  {
    code: ComplianceErrorCode.policyVersionInvalid,
    site: 'decision.ts версия политики',
    run: () => policyVersionId('2026-09-03'),
  },
  {
    code: ComplianceErrorCode.dualControlRequirementInvalid,
    site: 'dual-control.ts требование вне {1, 2}',
    run: () => dualControlRequirement(0),
  },
  {
    code: ComplianceErrorCode.capabilityNotGranted,
    site: 'roles.ts полномочия нет у роли',
    run: () =>
      // @ts-expect-error у роли поддержки нет полномочия read_beneficiary
      authorize(actor('support-1', SUPPORT_ROLE), 'read_beneficiary'),
  },
  {
    code: ComplianceErrorCode.aggregateNegative,
    site: 'concentration.ts отрицательный оборот месяца',
    run: () =>
      evaluateConcentration(
        { year: 2026, month: 9, currency: 'GEL', totalMinor: -1n, byCountry: [] },
        POLICY.concentration,
      ),
  },
  {
    code: ComplianceErrorCode.aggregateNegative,
    site: 'concentration.ts отрицательный оборот страны',
    run: () =>
      evaluateConcentration(
        {
          year: 2026,
          month: 9,
          currency: 'GEL',
          totalMinor: 100n,
          byCountry: [{ country: GE, minor: -1n }],
        },
        POLICY.concentration,
      ),
  },
  {
    code: ComplianceErrorCode.aggregatePartsExceedTotal,
    site: 'concentration.ts сумма частей больше целого',
    run: () =>
      evaluateConcentration(
        {
          year: 2026,
          month: 9,
          currency: 'GEL',
          totalMinor: 100n,
          byCountry: [{ country: GE, minor: 101n }],
        },
        POLICY.concentration,
      ),
  },
];

/**
 * Коды, объявленные в перечне, но не бросаемые ни одной строкой. Тест на них
 * написать нельзя: провокации не существует. Держим их в явном списке, а не
 * молчим, — новый осиротевший код уронит набор, а этот останется видимым.
 *
 * `aggregateCurrencyMismatch` — заявка на проверку «оборот страны в другой
 * валюте», которой в `concentration.ts` нет: `CountryTurnover` несёт только
 * минорные единицы, валюта объявлена один раз у месяца. Либо проверка, либо
 * код — решение владельца, поэтому здесь только фиксация факта.
 */
const KNOWN_ORPHANS: readonly ComplianceErrorCode[] = [
  ComplianceErrorCode.aggregateCurrencyMismatch,
];

function sourceTexts(): readonly string[] {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const texts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${directory}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) texts.push(readFileSync(`${directory}${entry.name}`, 'utf8'));
    }
  };
  walk(root);
  return texts;
}

function throwSitesByCode(): ReadonlyMap<string, number> {
  const pattern = /new ComplianceError\(\s*ComplianceErrorCode\.(\w+)/gu;
  const counts = new Map<string, number>();
  for (const text of sourceTexts()) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      counts.set(
        ComplianceErrorCode[name as keyof typeof ComplianceErrorCode],
        (counts.get(ComplianceErrorCode[name as keyof typeof ComplianceErrorCode]) ?? 0) + 1,
      );
    }
  }
  return counts;
}

describe('каждая проверка комплаенса роняется своим входом', () => {
  for (const provocation of PROVOCATIONS) {
    it(`${provocation.code} — ${provocation.site}`, () => {
      let thrown: unknown = null;
      try {
        provocation.run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ComplianceError);
      expect((thrown as ComplianceError).code).toBe(provocation.code);
    });
  }
});

describe('таблица провокаций сверена с исходником', () => {
  it('на каждое место throw есть вход, который его роняет', () => {
    const sites = throwSitesByCode();
    const provoked = new Map<string, number>();
    for (const provocation of PROVOCATIONS) {
      provoked.set(provocation.code, (provoked.get(provocation.code) ?? 0) + 1);
    }
    const shortfall: string[] = [];
    for (const [code, count] of sites) {
      if ((provoked.get(code) ?? 0) < count) {
        shortfall.push(`${code}: мест ${count}, провокаций ${provoked.get(code) ?? 0}`);
      }
    }
    expect(shortfall).toEqual([]);
  });

  it('осиротевшие коды — только те, что названы поимённо', () => {
    const sites = throwSitesByCode();
    const orphans = Object.values(ComplianceErrorCode).filter((code) => !sites.has(code));
    expect(orphans).toEqual(KNOWN_ORPHANS);
  });

  it('таблица не ссылается на код, которого в исходнике уже нет', () => {
    const sites = throwSitesByCode();
    expect(PROVOCATIONS.filter((item) => !sites.has(item.code)).map((item) => item.site)).toEqual([]);
  });
});

describe('веса ансамбля — величина, а не украшение', () => {
  const features = { levenshteinBp: 10_000, trigramBp: 0, jaroWinklerBp: 0 };

  it('другие законные веса дают другую оценку', () => {
    // Если бы `combineFeatures` игнорировала веса, обе оценки совпали бы.
    const byDefault = combineFeatures(features, DEFAULT_NAME_FEATURE_WEIGHTS);
    const shifted = combineFeatures(features, {
      levenshteinPercent: 60,
      trigramPercent: 20,
      jaroWinklerPercent: 20,
    });
    expect(byDefault).toBe(3_000);
    expect(shifted).toBe(6_000);
  });

  it('признак с нулевым весом на оценку не влияет', () => {
    expect(
      combineFeatures(
        { levenshteinBp: 10_000, trigramBp: 10_000, jaroWinklerBp: 0 },
        { levenshteinPercent: 100, trigramPercent: 0, jaroWinklerPercent: 0 },
      ),
    ).toBe(10_000);
  });

  it('единица весов — процент, и полный набор даёт исходный масштаб', () => {
    expect(
      combineFeatures(
        { levenshteinBp: 10_000, trigramBp: 10_000, jaroWinklerBp: 10_000 },
        DEFAULT_NAME_FEATURE_WEIGHTS,
      ),
    ).toBe(10_000);
  });
});

describe('неизвестная степень родства плательщика — отказ, а не молчание', () => {
  /**
   * `assertNever` в `detectors/payer.ts` — не украшение: степень родства
   * приходит из хранилища, а типы границу процесса не переживают. Без броска
   * функция вернула бы `undefined`, и вызывающий получил бы «оценка есть, поля
   * пустые» вместо отказа — то есть третье лицо платило бы по несуществующему
   * основанию.
   */
  it('вид родства вне перечня роняет оценку, а не проходит по умолчанию', () => {
    expect(() =>
      assessPayer(
        {
          buyerDocument: BUYER_DOCUMENT,
          origin: {
            kind: 'external_transfer',
            payerDocument: OTHER_DOCUMENT,
            senderNameMatch: compareNames(BUYER_NAMES, OTHER_NAMES, {
              strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp,
            }),
          },
          relationship: { kind: 'sibling' } as unknown as PayerRelationship,
          evidence: [],
        },
        POLICY.version,
        NOW,
      ),
    ).toThrow(/unhandled payer relationship/u);
  });
});
