import { type CurrencyCode, type Money, money } from '@sdelka/money';
import { type DurationMs, DAY, HOUR, duration } from '@sdelka/domain';
import { type PolicyVersionId, policyVersionId } from './decision';
import type { CountryCode } from './identity';
import { countryCode } from './identity';
import type { NameFeatureWeights } from './names';
import { DEFAULT_NAME_FEATURE_WEIGHTS } from './names';

/**
 * Политика комплаенса как версионированная сущность (`CORE.md` Ф11, `BACKLOG.md`
 * E6-11). Все пороги — здесь, ни одного магического числа в детекторах.
 */

export const VERIFICATION_LEVELS = ['standard', 'enhanced'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/**
 * Порог, обоснование которого обязано быть письменным. Порог без обоснования —
 * находка на аудите (`BACKLOG.md` E4-4), поэтому обоснование не комментарий, а
 * обязательное поле: ссылка на документ плюс ключ локализации для оператора.
 */
export interface JustifiedThreshold {
  readonly valueBp: number;
  readonly rationaleDocRef: string;
}

export interface NameThresholdPolicy {
  /**
   * Скрининг: дорог **пропуск**, поэтому порог ниже отраслевого ориентира 0,80 —
   * больше кандидатов уходит аналитику.
   */
  readonly screening: JustifiedThreshold;
  /**
   * Сверка собственника: дорого **ложное совпадение**, поэтому порог выше и
   * имя всё равно вторично к номеру документа. Один порог на обе задачи —
   * ошибка проектирования, у них противоположная цена ошибки.
   */
  readonly ownerReconciliation: JustifiedThreshold;
  readonly weights: NameFeatureWeights;
}

export interface SanctionsPolicy {
  /** Применяются буквально; грузинская оговорка в перечень источников не входит. */
  readonly lists: readonly SanctionsListSource[];
  /**
   * Оговорка от 04.08.2023 (санкции к гражданам Грузии только по приговору
   * грузинского суда) в нашей политике **не действует**. Тип литеральный:
   * значение `'applied'` не существует, и включить оговорку настройкой нельзя —
   * только правкой типа, которая видна в диффе.
   */
  readonly georgianCourtJudgmentCarveOut: 'disapplied';
  /** Ниже этого порога кандидат не показывается вовсе. */
  readonly candidateThreshold: JustifiedThreshold;
  /** Срок жизни записи белого списка. Разобранный ложный хит не вечен. */
  readonly whitelistTtl: DurationMs;
}

export const SANCTIONS_LIST_SOURCES = ['us_ofac', 'eu_consolidated', 'uk_ofsi'] as const;
export type SanctionsListSource = (typeof SANCTIONS_LIST_SOURCES)[number];

export interface BeneficiaryPolicy {
  /** Охлаждение при изменении реквизитов: 24–48 часов (`PRODUCT.md` §10, Ф15). */
  readonly cooldown: DurationMs;
  /** Изменение в последние 72 часа перед релизом — автоматический блок. */
  readonly preReleaseBlackout: DurationMs;
  readonly requiredApprovals: number;
}

export interface ConcentrationPolicy {
  /** Не более 25% месячного оборота от клиентов одной высокорисковой юрисдикции. */
  readonly highRiskCountryShareBp: number;
  /** Не более 40% на одну страну. */
  readonly singleCountryShareBp: number;
  /**
   * Совокупная доля всех высокорисковых юрисдикций. `CCO-compliance.md` формулирует
   * лимит 25% как совокупный по России и Беларуси, `PRODUCT.md` §10 — как лимит на
   * одну юрисдикцию. Считаем оба; расхождение документов вынесено в отчёт.
   */
  readonly highRiskAggregateShareBp: number;
  readonly highRiskJurisdictions: readonly CountryCode[];
}

export interface PricePolicy {
  /**
   * Допуск расхождения суммы через платформу с ценой в договоре. Ноль: сравниваются
   * две **заявленные** величины, а не полученная с отправленной, поэтому срезы
   * корреспондентов здесь ни при чём.
   */
  readonly toleranceBp: number;
}

export interface StructuringPolicy {
  readonly window: DurationMs;
  readonly minPaymentCount: number;
  /** Порог, ниже которого дробят. Задаётся в валюте политики. */
  readonly threshold: Money<CurrencyCode>;
}

export interface FlippingPolicy {
  readonly window: DurationMs;
  /** Скачок цены между переходами, при котором задача эскалируется. */
  readonly priceJumpBp: number;
}

export interface QueuePolicy {
  /** Пороги эскалации по **возрасту задачи**, от момента постановки. */
  readonly escalationAfter: readonly DurationMs[];
  /** Валюта ранжирования по сумме. Пороги задаются в лари (`FUNCTIONAL.md` §4.3.1). */
  readonly rankCurrency: CurrencyCode;
}

export interface CompliancePolicy {
  readonly version: PolicyVersionId;
  /**
   * Все наши сделки — усиленная проверка: чеки шестизначные. Уровень — поле
   * политики, а не вывод из суммы, поэтому «а если сделка маленькая» не имеет
   * места, где спрятаться.
   */
  readonly verificationLevel: VerificationLevel;
  readonly nameThresholds: NameThresholdPolicy;
  readonly sanctions: SanctionsPolicy;
  readonly beneficiary: BeneficiaryPolicy;
  readonly concentration: ConcentrationPolicy;
  readonly price: PricePolicy;
  readonly structuring: StructuringPolicy;
  readonly flipping: FlippingPolicy;
  readonly queue: QueuePolicy;
}

const NAMES_DOC = 'docs/research/LOCALIZATION-NAMES.md#сопоставление-имён';

export const POLICY_2026_09_03: CompliancePolicy = Object.freeze({
  version: policyVersionId('compliance/2026-09-03.1'),
  verificationLevel: 'enhanced',
  nameThresholds: Object.freeze({
    screening: Object.freeze({ valueBp: 8_000, rationaleDocRef: NAMES_DOC }),
    ownerReconciliation: Object.freeze({ valueBp: 9_500, rationaleDocRef: NAMES_DOC }),
    weights: DEFAULT_NAME_FEATURE_WEIGHTS,
  }),
  sanctions: Object.freeze({
    lists: Object.freeze(['us_ofac', 'eu_consolidated', 'uk_ofsi'] as const),
    georgianCourtJudgmentCarveOut: 'disapplied',
    candidateThreshold: Object.freeze({ valueBp: 7_000, rationaleDocRef: NAMES_DOC }),
    whitelistTtl: duration(180 * DAY),
  }),
  beneficiary: Object.freeze({
    cooldown: duration(24 * HOUR),
    preReleaseBlackout: duration(72 * HOUR),
    requiredApprovals: 1,
  }),
  concentration: Object.freeze({
    highRiskCountryShareBp: 2_500,
    singleCountryShareBp: 4_000,
    highRiskAggregateShareBp: 2_500,
    highRiskJurisdictions: Object.freeze([countryCode('RU'), countryCode('BY')]),
  }),
  price: Object.freeze({ toleranceBp: 0 }),
  structuring: Object.freeze({
    window: duration(7 * DAY),
    minPaymentCount: 3,
    threshold: money('GEL', 3_000_000n),
  }),
  flipping: Object.freeze({
    window: duration(90 * DAY),
    priceJumpBp: 2_000,
  }),
  queue: Object.freeze({
    escalationAfter: Object.freeze([duration(4 * HOUR), duration(24 * HOUR), duration(72 * HOUR)]),
    rankCurrency: 'GEL',
  }),
});

/**
 * Требуемый уровень проверки. Возвращает `enhanced` всегда — не потому, что
 * функция вырождена, а потому что таково решение: чеки шестизначные, дешёвого
 * KYC не будет. Сумма в аргументах оставлена намеренно: если решение когда-нибудь
 * изменится, изменится тело функции, а не сигнатуры всех вызовов.
 */
export function requiredVerificationLevel(
  policy: CompliancePolicy,
  _amount: Money<CurrencyCode> | null,
): VerificationLevel {
  return policy.verificationLevel;
}

/**
 * Гражданство само по себе не основание для отказа, но высокорисковое
 * автоматически даёт усиленную проверку независимо от суммы.
 */
export function hasHighRiskNationality(
  policy: CompliancePolicy,
  nationalities: readonly CountryCode[],
): boolean {
  return nationalities.some((country) => policy.concentration.highRiskJurisdictions.includes(country));
}
