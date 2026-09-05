import { describe, expect, it } from 'vitest';
import {
  AUDIT_RECORD_KINDS,
  AUDIT_ROLES,
  AuditErrorCode,
  type CorrectionBody,
  type DecisionMadeBody,
  type PayoutOrderedBody,
  type PayoutResultBody,
  RELEASE_CONDITION_KINDS,
  auditActor,
  auditAmount,
  policyRef,
} from '../src/index';
import { BENEFICIARY, COMPLIANCE_POLICY, expectAuditError, source } from './support/fixtures';

/**
 * Обязательность полей проверяется компилятором, а не рантаймом: `@ts-expect-error`
 * ниже — это утверждения, которые проверяет `pnpm typecheck` (vitest сборку не
 * типизирует, поэтому здесь же оставлены рантайм-проверки, чтобы тест не был
 * пустым при прогоне).
 */
describe('тело записи: обязательное обязательно по типу', () => {
  it('решение без версии политики не собирается', () => {
    // @ts-expect-error — нет `policy`: `FUNCTIONAL.md` инвариант 23
    const body: DecisionMadeBody = {
      kind: 'decision_made',
      outcomeKey: 'clear',
      reasonKeys: [],
      evidence: [source(1)],
    };
    expect(body.kind).toBe('decision_made');
  });

  it('решение с пустым пакетом доказательств не собирается', () => {
    const body: DecisionMadeBody = {
      kind: 'decision_made',
      outcomeKey: 'clear',
      policy: COMPLIANCE_POLICY,
      reasonKeys: [],
      // @ts-expect-error — пустой массив не является непустым набором
      evidence: [],
    };
    expect(body.evidence).toHaveLength(0);
  });

  it('поручение на выплату без пакета доказательств не собирается', () => {
    const body: PayoutOrderedBody = {
      kind: 'payout_ordered',
      idempotencyKey: 'payout-idem-1',
      amount: auditAmount('GEL', 1n),
      beneficiary: BENEFICIARY,
      policy: COMPLIANCE_POLICY,
      // @ts-expect-error — красная линия №5: кнопки «просто выплатить» не существует
      evidencePackage: [],
    };
    expect(body.kind).toBe('payout_ordered');
  });

  it('исправление без ссылки на исправляемую запись не собирается', () => {
    // @ts-expect-error — красная линия №11, инвариант 22
    const body: CorrectionBody = {
      kind: 'correction',
      reasonKey: 'evidence.provider_misattributed',
      basis: source(9, 'operator_note', 'console'),
      attributes: {},
    };
    expect(body.kind).toBe('correction');
  });

  it('исправление без основания не собирается', () => {
    // @ts-expect-error — `CORE.md` Ф11: разобранные поля без исходника суд не
    // убедит. Исправление без основания — мнение, дописанное в вечный журнал.
    const body: CorrectionBody = {
      kind: 'correction',
      correctsRecordId: 'rec-evidence',
      reasonKey: 'evidence.provider_misattributed',
      attributes: {},
    };
    expect(body.kind).toBe('correction');
  });

  it('успешная выплата без сырого ответа провайдера не собирается', () => {
    // @ts-expect-error — `settled` обязан нести ответ: `CORE.md` Ф11
    const body: PayoutResultBody = { kind: 'payout_result', outcome: 'settled', response: null };
    expect(body.outcome).toBe('settled');
  });

  it('«неизвестно» без ответа собирается — это легальное состояние', () => {
    // `STATE-MACHINES.md` §2: ответа нет именно потому, что он потерян.
    const body: PayoutResultBody = {
      kind: 'payout_result',
      outcome: 'unknown',
      response: null,
      reasonKey: 'payout.network_timeout',
    };
    expect(body.reasonKey).toBe('payout.network_timeout');
  });
});

describe('версия политики', () => {
  it('формат совместим с PolicyVersionId комплаенса', () => {
    expect(policyRef('compliance/2026-09-03.1')).toBe('compliance/2026-09-03.1');
    expect(policyRef('payout/2026-09-01.12')).toBe('payout/2026-09-01.12');
  });

  it('произвольная строка версией политики не является', () => {
    expectAuditError(() => policyRef('v1'), AuditErrorCode.policyRefInvalid);
    expectAuditError(() => policyRef('compliance/2026-09-03'), AuditErrorCode.policyRefInvalid);
    expectAuditError(() => policyRef('Compliance/2026-09-03.1'), AuditErrorCode.policyRefInvalid);
  });
});

describe('закрытые перечни', () => {
  it('виды записей и роли перечислены и заморожены', () => {
    expect(AUDIT_RECORD_KINDS).toContain('correction');
    expect(AUDIT_RECORD_KINDS).toContain('personal_data_viewed');
    expect(AUDIT_ROLES).toContain('oracle');
    expect(AUDIT_ROLES).toContain('system');
  });

  it('тип условия — ровно три значения из STATE-MACHINES.md §8', () => {
    expect([...RELEASE_CONDITION_KINDS]).toEqual([
      'registration_transfer',
      'registration_preliminary',
      'calendar_date',
    ]);
  });

  it('актор без полномочия допустим только явным null', () => {
    expect(auditActor('system', 'system').capability).toBeNull();
  });
});
