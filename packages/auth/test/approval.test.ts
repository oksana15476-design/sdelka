import { describe, expect, it } from 'vitest';
import {
  type ActorRef,
  type ApprovalRecord,
  AUTH_REASON_KEYS,
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
