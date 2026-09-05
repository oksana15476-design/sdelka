import { describe, expect, it } from 'vitest';
import {
  type BeneficiaryPolicy,
  ALL_REASON_KEYS,
  hasHighRiskNationality,
  policyVersionId,
  POLICY_2026_09_03,
  requiredVerificationLevel,
} from '../src/index';
import { BY, DE, IL, POLICY, RU } from './support/fixtures';

describe('уровень проверки — политика с версией', () => {
  it('все сделки идут по усиленной проверке', () => {
    expect(requiredVerificationLevel(POLICY, null)).toBe('enhanced');
    expect(POLICY.verificationLevel).toBe('enhanced');
  });

  it('высокорисковое гражданство распознаётся', () => {
    expect(hasHighRiskNationality(POLICY, [RU])).toBe(true);
    expect(hasHighRiskNationality(POLICY, [BY])).toBe(true);
    expect(hasHighRiskNationality(POLICY, [DE, IL])).toBe(false);
  });

  it('идентификатор версии валидируется по формату', () => {
    expect(policyVersionId('compliance/2026-09-03.1')).toBe('compliance/2026-09-03.1');
    expect(() => policyVersionId('v1')).toThrow('compliance.policy_version.invalid');
  });

  it('лимиты концентрации совпадают с документом', () => {
    expect(POLICY.concentration.highRiskCountryShareBp).toBe(2_500);
    expect(POLICY.concentration.singleCountryShareBp).toBe(4_000);
  });

  it('охлаждение реквизитов в диапазоне 24–48 часов, запрет — 72 часа', () => {
    const hour = 60 * 60 * 1000;
    expect(POLICY.beneficiary.cooldown).toBeGreaterThanOrEqual(24 * hour);
    expect(POLICY.beneficiary.cooldown).toBeLessThanOrEqual(48 * hour);
    expect(POLICY.beneficiary.preReleaseBlackout).toBe(72 * hour);
  });

  it('изменение реквизитов без второго человека невыразимо политикой', () => {
    expect(POLICY.beneficiary.requiredApprovals).toBe(1);
    const withoutApproval: Omit<BeneficiaryPolicy, 'requiredApprovals'> = {
      cooldown: POLICY.beneficiary.cooldown,
      preReleaseBlackout: POLICY.beneficiary.preReleaseBlackout,
    };
    // Компиляционный тест: ноль в политике означал бы «реквизиты выплаты
    // меняются без второго утверждения», и включался бы он правкой одного
    // значения. Исчезнет запрет — этот файл перестанет собираться.
    // @ts-expect-error ноль утверждений — не порог, а его отсутствие
    const zero: BeneficiaryPolicy = { ...withoutApproval, requiredApprovals: 0 };
    expect(zero.requiredApprovals).toBe(0);
  });

  /**
   * Числа политики — это и есть решение о риске, а не настройка удобства.
   * Ни у одного из них нет второго места, где расхождение стало бы видно:
   * порог, сдвинутый на единицу, не ломает ни один сценарий — он молча меняет,
   * кого пропустят. Поэтому значения пинуются здесь целиком и вместе с
   * идентификатором версии: **версия и набор значений обязаны меняться вместе**.
   */
  it('значения политики — те, что записаны в документах, и версия им соответствует', () => {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    expect(POLICY.version).toBe('compliance/2026-09-03.1');
    expect(POLICY.verificationLevel).toBe('enhanced');

    expect(POLICY.nameThresholds.screening.valueBp).toBe(8_000);
    expect(POLICY.nameThresholds.ownerReconciliation.valueBp).toBe(9_500);
    // Цена ошибки у задач противоположна: у скрининга дорог пропуск, у сверки
    // собственника — ложное совпадение. Один порог на обе — ошибка проектирования.
    expect(POLICY.nameThresholds.screening.valueBp).toBeLessThan(
      POLICY.nameThresholds.ownerReconciliation.valueBp,
    );

    expect(POLICY.sanctions.candidateThreshold.valueBp).toBe(7_000);
    expect(POLICY.sanctions.whitelistTtl).toBe(180 * day);

    expect(POLICY.beneficiary.cooldown).toBe(24 * hour);
    expect(POLICY.beneficiary.preReleaseBlackout).toBe(72 * hour);

    expect(POLICY.concentration.highRiskAggregateShareBp).toBe(2_500);
    expect([...POLICY.concentration.highRiskJurisdictions]).toEqual(['RU', 'BY']);

    // Ноль: сравниваются две заявленные величины, а не полученная с отправленной.
    expect(POLICY.price.toleranceBp).toBe(0);

    expect(POLICY.structuring.window).toBe(7 * day);
    expect(POLICY.structuring.minPaymentCount).toBe(3);
    expect(POLICY.structuring.threshold.currency).toBe('GEL');
    expect(POLICY.structuring.threshold.minor).toBe(3_000_000n);

    expect(POLICY.flipping.window).toBe(90 * day);
    expect(POLICY.flipping.priceJumpBp).toBe(2_000);

    expect([...POLICY.queue.escalationAfter]).toEqual([4 * hour, 24 * hour, 72 * hour]);
    expect(POLICY.queue.rankCurrency).toBe('GEL');
  });

  it('у каждого порога есть письменное обоснование', () => {
    for (const threshold of [
      POLICY.nameThresholds.screening,
      POLICY.nameThresholds.ownerReconciliation,
      POLICY.sanctions.candidateThreshold,
    ]) {
      expect(threshold.rationaleDocRef).toMatch(/^docs\//u);
    }
  });

  it('политика заморожена: значения не правятся в рантайме', () => {
    expect(Object.isFrozen(POLICY_2026_09_03)).toBe(true);
    expect(Object.isFrozen(POLICY_2026_09_03.sanctions)).toBe(true);
  });
});

describe('пользовательского текста в пакете нет', () => {
  it('все причины — ключи локализации в пространстве compliance', () => {
    for (const key of ALL_REASON_KEYS) {
      expect(key).toMatch(/^compliance\.[a-z_]+\.[a-z_]+$/u);
    }
  });

  it('ключи уникальны', () => {
    expect(new Set(ALL_REASON_KEYS).size).toBe(ALL_REASON_KEYS.length);
  });
});
