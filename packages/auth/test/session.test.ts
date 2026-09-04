import { duration, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  AUTH_REASON_KEYS,
  CLIENT_SESSION_POLICY,
  CONSOLE_SESSION_POLICY,
  accountId,
  establishSession,
  personId,
  policyForRole,
  sessionId,
  sessionRejection,
  sessionStatus,
  stepUpSatisfied,
  touch,
  revoke,
  withAssertion,
} from '../src/index';
import { NOW, at, factor, sessionFor } from './support';

const REQUEST = {
  sessionId: sessionId('s-1'),
  accountId: accountId('acc-fc'),
  personId: personId('per-fc'),
  roleId: 'financial_controller' as const,
  onDuty: false,
  primary: { method: 'passkey' as const, at: NOW, device: null, network: null },
  factors: [factor('webauthn')],
  requestedTtl: duration(60 * 60 * 1000),
};

describe('выдача сессии', () => {
  it('консольная роль входит с устойчивым фактором', () => {
    const result = establishSession(REQUEST, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt).toBe(at(60 * 60 * 1000));
    expect(result.value.revokedAt).toBeNull();
  });

  it('консольная роль без второго фактора не входит', () => {
    const result = establishSession({ ...REQUEST, factors: [] }, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.secondFactorMissing });
  });

  it('код в письме вторым фактором для консоли не считается', () => {
    // Р6 вариант B: защищает от чего угодно, кроме сценария, который нас убивает.
    const result = establishSession({ ...REQUEST, factors: [factor('email')] }, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.secondFactorTooWeak });
  });

  it('ссылка в письме первичным способом для консоли запрещена', () => {
    const result = establishSession(
      { ...REQUEST, primary: { method: 'magic_link', at: NOW, device: null, network: null } },
      NOW,
    );
    expect(result).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole,
    });
  });

  it('срок сверх политики не выдаётся', () => {
    const ttl = duration(48 * 60 * 60 * 1000);
    const result = establishSession({ ...REQUEST, requestedTtl: ttl }, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.sessionTtlTooLong });
  });

  it('кабинет стороны входит без второго фактора', () => {
    const result = establishSession({ ...REQUEST, roleId: 'party', factors: [] }, NOW);
    expect(result.ok).toBe(true);
  });
});

describe('дежурство при выдаче', () => {
  it('включается только тем ролям, которые дежурят', () => {
    const ok = establishSession({ ...REQUEST, onDuty: true }, NOW);
    expect(ok.ok).toBe(true);
  });

  it('на комплаенс-аналитика не включается: дежурство — не новая роль', () => {
    const request = { ...REQUEST, roleId: 'compliance_analyst' as const, onDuty: true };
    const result = establishSession(request, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.dutyRoleNotEligible });
  });
});

describe('срок сессии', () => {
  it('жива, пока не истекла и не простаивала', () => {
    const session = sessionFor('operator', 'acc-op');
    expect(sessionStatus(session, at(60 * 1000))).toBe('active');
    expect(sessionRejection('active')).toBeNull();
  });

  it('истекает по абсолютному сроку', () => {
    const session = sessionFor('operator', 'acc-op', { expiresAt: at(1000) });
    expect(sessionStatus(session, at(1000))).toBe('expired');
    expect(sessionRejection('expired')).toBe(AUTH_REASON_KEYS.sessionExpired);
  });

  it('истекает по простою, и отметка активности не двигает абсолютный срок', () => {
    const session = sessionFor('operator', 'acc-op');
    const idleAt = at(20 * 60 * 1000);
    expect(sessionStatus(session, idleAt)).toBe('idle');

    const touched = touch(session, at(10 * 60 * 1000));
    expect(sessionStatus(touched, idleAt)).toBe('active');
    expect(touched.expiresAt).toBe(session.expiresAt);
  });

  it('отозванная не оживает отметкой активности', () => {
    const session = touch(revoke(sessionFor('operator', 'acc-op'), at(1000)), at(2000));
    expect(sessionStatus(session, at(2000))).toBe('revoked');
  });
});

describe('свежесть второго фактора', () => {
  it('свежее подтверждение проходит', () => {
    const session = sessionFor('financial_controller', 'acc-fc', {
      factors: [factor('webauthn', at(60 * 1000))],
    });
    const result = stepUpSatisfied(session, at(2 * 60 * 1000));
    expect(result.ok).toBe(true);
  });

  it('подтверждение восьмичасовой давности не подтверждает того, кто нажимает сейчас', () => {
    const session = sessionFor('financial_controller', 'acc-fc', {
      factors: [factor('webauthn', instant(NOW - 8 * 60 * 60 * 1000))],
    });
    expect(stepUpSatisfied(session, NOW)).toEqual({
      ok: false,
      error: AUTH_REASON_KEYS.secondFactorStale,
    });
  });

  it('берётся свежайшее из накопленных, прежние не теряются', () => {
    const session = withAssertion(
      sessionFor('financial_controller', 'acc-fc', {
        factors: [factor('webauthn', instant(NOW - 60 * 60 * 1000))],
      }),
      factor('webauthn', at(60 * 1000)),
    );
    expect(session.factors).toHaveLength(2);
    expect(stepUpSatisfied(session, at(2 * 60 * 1000)).ok).toBe(true);
  });
});

describe('политика не подменяется аргументом', () => {
  it('выдача сессии политику не принимает', () => {
    const attempt = () => {
      // @ts-expect-error третьего аргумента нет. С политикой кабинета консольная
      // роль входила без второго фактора и на сутки вместо восьми часов.
      establishSession({ ...REQUEST, factors: [] }, CLIENT_SESSION_POLICY, NOW);
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('консольной роли клиентская политика входа не достаётся', () => {
    // Тот самый вход: консольная роль, второго фактора нет. По клиентской
    // политике он был бы законным, по политике роли — нет.
    expect(CLIENT_SESSION_POLICY.secondFactorAtLogin).toBe(false);
    const result = establishSession({ ...REQUEST, factors: [] }, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.secondFactorMissing });
  });

  it('срок жизни ограничен политикой роли, а не переданной', () => {
    // 24 часа законны для кабинета и вдвое больше консольного потолка.
    const ttl = CLIENT_SESSION_POLICY.maxTtl;
    const result = establishSession({ ...REQUEST, requestedTtl: ttl }, NOW);
    expect(result).toEqual({ ok: false, error: AUTH_REASON_KEYS.sessionTtlTooLong });
  });

  it('состояние и свежесть фактора считаются по роли сессии', () => {
    const idleAt = at(20 * 60 * 1000);
    expect(sessionStatus(sessionFor('financial_controller', 'acc-fc'), idleAt)).toBe('idle');
    expect(sessionStatus(sessionFor('party', 'acc-pt'), idleAt)).toBe('active');

    const attempt = () => {
      // @ts-expect-error политика перестала быть аргументом и здесь
      stepUpSatisfied(sessionFor('party', 'acc-pt'), CLIENT_SESSION_POLICY, NOW);
    };
    expect(attempt).toBeTypeOf('function');
  });
});

describe('политика по роли', () => {
  it('консоль строже кабинета по простою и по силе фактора', () => {
    expect(policyForRole('operator')).toBe(CONSOLE_SESSION_POLICY);
    expect(policyForRole('party')).toBe(CLIENT_SESSION_POLICY);
    expect(policyForRole('auditor').secondFactorAtLogin).toBe(true);
    expect(CONSOLE_SESSION_POLICY.minimumFactorStrength).toBe('phishing_resistant');
  });

  it('срок и простой — целые положительные величины домена', () => {
    expect(CONSOLE_SESSION_POLICY.idleTtl).toBe(duration(15 * 60 * 1000));
  });
});
