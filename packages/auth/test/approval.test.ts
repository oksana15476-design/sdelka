import { describe, expect, it } from 'vitest';
import {
  type ActorRef,
  type ApprovalRecord,
  type ApprovalRequirement,
  APPROVAL_REQUIREMENTS,
  AUTH_REASON_KEYS,
  UNKNOWN_FACT,
  approvalRequirement,
  evaluateQuorum,
  recordApproval,
} from '../src/index';
import { NOW, actor } from './support';

const FC = actor('acc-fc', 'per-fc');
const FC2 = actor('acc-fc2', 'per-fc2');
const RO = actor('acc-ro', 'per-ro');
const OPERATOR = actor('acc-op', 'per-op');

function approval(
  who: ActorRef,
  roleId: 'financial_controller' | 'head_of_operations',
): ApprovalRecord {
  const result = recordApproval(who, roleId, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('утверждение собирается только ролью с уровнем', () => {
  it('поддержка утверждение не создаёт', () => {
    expect(recordApproval(actor('acc-pd'), 'support', NOW)).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.sodApprovalLevelMissing,
    });
  });

  it('владелец утверждение не создаёт', () => {
    expect(recordApproval(actor('acc-vl'), 'principal', NOW).ok).toBe(false);
  });

  it('финконтролёр даёт уровень 1, руководитель операций — уровень 2', () => {
    expect(approval(FC, 'financial_controller').level).toBe(1);
    expect(approval(RO, 'head_of_operations').level).toBe(2);
  });
});

describe('кворум по набору уровней', () => {
  it('одна подпись — уровень 1', () => {
    const result = evaluateQuorum({
      required: 1,
      preparedBy: OPERATOR,
      approvals: [approval(FC, 'financial_controller')],
    });
    expect(result.ok).toBe(true);
  });

  it('две подписи одного уровня кворум не набирают', () => {
    // `ACTORS.md` §5.2: тариф «две подписи» = один уровень 1 плюс один уровень 2,
    // а не две любые. Раньше держалось только на различии `userId`.
    const result = evaluateQuorum({
      required: 2,
      preparedBy: OPERATOR,
      approvals: [approval(FC, 'financial_controller'), approval(FC2, 'financial_controller')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumLevelTwoMissing });
  });

  it('уровень 1 плюс уровень 2 кворум набирают', () => {
    const result = evaluateQuorum({
      required: 2,
      preparedBy: OPERATOR,
      approvals: [approval(FC, 'financial_controller'), approval(RO, 'head_of_operations')],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.counted).toHaveLength(2);
  });

  it('руководитель операций в одиночку ступень одной подписи не закрывает', () => {
    // Строгое прочтение: уровень 2 определён как «второе утверждение». Развилка
    // владельца — см. отчёт.
    const result = evaluateQuorum({
      required: 1,
      preparedBy: OPERATOR,
      approvals: [approval(RO, 'head_of_operations')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumLevelOneMissing });
  });

  it('готовивший операцию к кворуму не засчитывается', () => {
    const result = evaluateQuorum({
      required: 1,
      preparedBy: FC,
      approvals: [approval(FC, 'financial_controller')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumApproversNotDistinct });
  });

  it('одна рука, нажавшая дважды, — одно утверждение', () => {
    const one = approval(FC, 'financial_controller');
    const result = evaluateQuorum({
      required: 2,
      preparedBy: OPERATOR,
      approvals: [one, one],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumApproversNotDistinct });
  });

  it('один человек с двух учётных записей — тоже одно утверждение', () => {
    const twoAccountsOneHuman = actor('acc-ro2', 'per-fc');
    const result = evaluateQuorum({
      required: 2,
      preparedBy: OPERATOR,
      approvals: [
        approval(FC, 'financial_controller'),
        approval(twoAccountsOneHuman, 'head_of_operations'),
      ],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumApproversNotDistinct });
  });

  it('ступень, которая не берётся вовсе, кворумом не закрывается', () => {
    const result = evaluateQuorum({
      required: null,
      preparedBy: OPERATOR,
      approvals: [approval(FC, 'financial_controller'), approval(RO, 'head_of_operations')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumTierNotOffered });
  });
});

describe('ноль утверждений — не кворум, а его отсутствие', () => {
  it('ступень с нулём подписей невыразима типом', () => {
    const attempt = () => {
      // @ts-expect-error `required` это 1 | 2 | null. Раньше стоял `number`, и
      // `{ required: 0 }` отвечало «кворум набран» без единого утверждения.
      evaluateQuorum({ required: 0, preparedBy: OPERATOR, approvals: [] });
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('и не проходит, если пришла из-за границы процесса', () => {
    // Ступень лежит в базе; тип туда не поедет, поэтому рантайм-рубеж обязателен.
    const fromDatabase = 0 as unknown as ApprovalRequirement;
    const result = evaluateQuorum({
      required: fromDatabase,
      preparedBy: OPERATOR,
      approvals: [],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumRequirementInvalid });
  });

  it('и не проходит даже с полным набором подписей', () => {
    // Отказ именно по ступени, а не по нехватке утверждений: подписи на месте.
    const result = evaluateQuorum({
      required: 0 as unknown as ApprovalRequirement,
      preparedBy: OPERATOR,
      approvals: [approval(FC, 'financial_controller'), approval(RO, 'head_of_operations')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumRequirementInvalid });
  });

  it('разбор ступени из настройки отвергает ноль, тройку и дробь', () => {
    expect(() => approvalRequirement(0)).toThrow();
    expect(() => approvalRequirement(-1)).toThrow();
    expect(() => approvalRequirement(3)).toThrow();
    expect(() => approvalRequirement(1.5)).toThrow();
    expect(() => approvalRequirement(Number.NaN)).toThrow();
    expect(approvalRequirement(1)).toBe(1);
    expect(approvalRequirement(2)).toBe(2);
    expect(APPROVAL_REQUIREMENTS).toHaveLength(2);
  });
});

describe('неизвестный готовивший кворум не закрывает', () => {
  it('«не выясняли, кто готовил» — отказ, а не отсутствие Н1', () => {
    // Прежде поле было `ActorRef | null`, и `null` молча снимал проверку Н1:
    // готовивший засчитывался в кворум наравне со всеми.
    const result = evaluateQuorum({
      required: 1,
      preparedBy: UNKNOWN_FACT,
      approvals: [approval(FC, 'financial_controller')],
    });
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.quorumPreparerUnknown });
  });

  it('операция без готовившего вовсе не выражается', () => {
    const attempt = () => {
      // @ts-expect-error `null` больше не значение этого поля — см. отчёт:
      // подготовка нечеловеческим актором (`system`) невыразима намеренно.
      evaluateQuorum({ required: 1, preparedBy: null, approvals: [] });
    };
    expect(attempt).toBeTypeOf('function');
  });
});
