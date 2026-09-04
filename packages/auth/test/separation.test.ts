import { describe, expect, it } from 'vitest';
import {
  type ActionContext,
  AUTH_REASON_KEYS,
  EMPTY_CONTEXT,
  evaluateSeparation,
} from '../src/index';
import { actor } from './support';

const FC = actor('acc-fc', 'per-fc');
const OPERATOR = actor('acc-op', 'per-op');
const ORACLE = actor('acc-or', 'per-or');

function context(patch: Partial<ActionContext>): ActionContext {
  return { ...EMPTY_CONTEXT, ...patch };
}

describe('Н1 — готовил ≠ утверждает', () => {
  it('утверждение готовившего отвергается', () => {
    const violations = evaluateSeparation(
      'approve_payout',
      'financial_controller',
      FC,
      context({ preparedBy: [FC] }),
    );
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodPreparerCannotApprove,
    );
  });

  it('утверждение постороннего проходит', () => {
    expect(
      evaluateSeparation(
        'approve_payout',
        'financial_controller',
        FC,
        context({ preparedBy: [OPERATOR] }),
      ),
    ).toEqual([]);
  });
});

describe('Н2 — установил факт ≠ утвердил выплату по той же сделке', () => {
  it('утверждение внёсшего наблюдение отвергается', () => {
    const violations = evaluateSeparation(
      'approve_payout',
      'financial_controller',
      FC,
      context({ observedBy: [FC] }),
    );
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodObserverCannotApprove,
    );
  });

  it('ловит того же человека с другой учётной записи', () => {
    // §6.6 прямо предусматривает совмещение должностей по времени: учётные
    // записи разные, человек один. Правило на одном `accountId` здесь молчит.
    const sameHumanOtherAccount = actor('acc-fc-2', 'per-or');
    const violations = evaluateSeparation(
      'approve_payout',
      'financial_controller',
      sameHumanOtherAccount,
      context({ observedBy: [ORACLE] }),
    );
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodObserverCannotApprove,
    );
  });
});

describe('Н3 — уровень утверждения', () => {
  it('роль без уровня утверждающей не является', () => {
    const violations = evaluateSeparation('approve_payout', 'support', actor('acc-pd'), EMPTY_CONTEXT);
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodApprovalLevelMissing,
    );
  });
});

describe('Н4 — ввёл реквизиты ≠ утвердил изменение', () => {
  it('запросивший изменение его не утверждает', () => {
    const violations = evaluateSeparation(
      'approve_beneficiary_change',
      'financial_controller',
      FC,
      context({ beneficiaryChangeRequestedBy: [FC] }),
    );
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodRequesterCannotApprove,
    );
  });
});

describe('Н5 — вызвал расхождение ≠ снял остановку', () => {
  it('автор действия остановку не снимает', () => {
    const violations = evaluateSeparation(
      'lift_halt',
      'financial_controller',
      FC,
      context({ causedBy: [FC] }),
    );
    expect(violations.map((item) => item.reason)).toContain(AUTH_REASON_KEYS.sodCauserCannotLift);
  });

  it('и не подтверждает снятие блокировки, которую вызвал', () => {
    const violations = evaluateSeparation(
      'approve_lift_block',
      'head_of_operations',
      FC,
      context({ causedBy: [FC] }),
    );
    expect(violations.map((item) => item.reason)).toContain(AUTH_REASON_KEYS.sodCauserCannotLift);
  });
});

describe('Н6 — видит маржу ≠ имеет полномочие с денежным эффектом', () => {
  it('аудитор, видящий экономику, ничего не утверждает', () => {
    const violations = evaluateSeparation('approve_payout', 'auditor', actor('acc-au'), EMPTY_CONTEXT);
    expect(violations.map((item) => item.reason)).toContain(
      AUTH_REASON_KEYS.sodEconomicsExcludesMoney,
    );
  });

  it('чтение экономики само по себе ничего не нарушает', () => {
    expect(evaluateSeparation('read_economics', 'principal', actor('acc-vl'), EMPTY_CONTEXT)).toEqual(
      [],
    );
  });

  it('рычаги владельцу принадлежат и Н6 их не задевает', () => {
    expect(
      evaluateSeparation('manage_settings', 'principal', actor('acc-vl'), EMPTY_CONTEXT),
    ).toEqual([]);
  });
});

describe('перечень нарушений', () => {
  it('возвращаются все, а не первое', () => {
    const violations = evaluateSeparation(
      'approve_payout',
      'support',
      FC,
      context({ preparedBy: [FC], observedBy: [FC] }),
    );
    expect(violations.map((item) => item.rule)).toEqual([
      'n1_preparer_not_approver',
      'n2_observer_not_approver',
      'n3_levels_distinct',
    ]);
  });
});
