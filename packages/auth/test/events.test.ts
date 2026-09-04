import { describe, expect, it } from 'vitest';
import {
  AUTH_REASON_KEYS,
  accountId,
  authorizationOutcome,
  decide,
  decideCapability,
  dutyChanged,
  personId,
  roleChanged,
  sessionDenied,
  sessionEstablished,
  sessionRevoked,
} from '../src/index';
import { NOW, at, context, sessionFor } from './support';

describe('журнал входов', () => {
  it('вход записывается с ролью, способом и сроком', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const event = sessionEstablished(session, 'webauthn');
    expect(event.kind).toBe('session_established');
    expect(event.actor.roleId).toBe('financial_controller');
    expect(event.primaryMethod).toBe('passkey');
    expect(event.expiresAt).toBe(session.expiresAt);
  });

  it('отказ во входе записывается с причиной и без сессии', () => {
    const event = sessionDenied(
      { accountId: accountId('acc-fc'), personId: personId('per-fc'), roleId: null, onDuty: false },
      'magic_link',
      AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole,
      NOW,
      null,
      null,
    );
    expect(event.sessionId).toBeNull();
    expect(event.reason).toBe(AUTH_REASON_KEYS.primaryMethodNotAllowedForConsole);
  });

  it('отпечатки в отказе не проставляются умолчанием', () => {
    const attempt = () => {
      // @ts-expect-error device и network обязательны: запись об отказе во входе
      // ведётся ради них, а умолчание `null` получалось молчанием вызывающего.
      sessionDenied(
        {
          accountId: accountId('acc-fc'),
          personId: personId('per-fc'),
          roleId: null,
          onDuty: false,
        },
        'password',
        AUTH_REASON_KEYS.secondFactorMissing,
        NOW,
      );
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('отзыв записывается отдельным событием', () => {
    const session = sessionFor('operator', 'acc-op');
    expect(sessionRevoked(session, AUTH_REASON_KEYS.sessionRevoked, at(1000)).kind).toBe(
      'session_revoked',
    );
  });

  it('дежурство открывается и закрывается событиями', () => {
    const session = sessionFor('operator', 'acc-op', { onDuty: true });
    expect(dutyChanged(session, true, NOW).kind).toBe('duty_started');
    expect(dutyChanged(session, false, at(1000)).kind).toBe('duty_ended');
  });
});

describe('журнал смен роли', () => {
  it('снятие прежней роли записано раньше назначения новой', () => {
    const events = roleChanged(
      accountId('acc-1'),
      personId('per-1'),
      'operator',
      'financial_controller',
      accountId('acc-admin'),
      NOW,
    );
    expect(events.map((item) => item.kind)).toEqual(['role_revoked', 'role_assigned']);
    expect(events[0]?.roleId).toBe('operator');
    expect(events[1]?.roleId).toBe('financial_controller');
  });

  it('первое назначение — одно событие', () => {
    const events = roleChanged(accountId('acc-1'), personId('per-1'), null, 'support', null, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('role_assigned');
    expect(events[0]?.orderedBy).toBeNull();
  });
});

describe('журнал решений', () => {
  it('чтение сделки журнал не засоряет', () => {
    const session = sessionFor('operator', 'acc-op');
    const outcome = decide(session, 'read_deal', at(1000), context());
    expect(authorizationOutcome(session, outcome, at(1000))).toBeNull();
  });

  it('успешное действие с последствиями записывается', () => {
    const session = sessionFor('operator', 'acc-op');
    const outcome = decide(session, 'create_deal', at(1000), context());
    const event = authorizationOutcome(session, outcome, at(1000));
    expect(event?.kind).toBe('authorization_granted');
    expect(event?.capability).toBe('create_deal');
  });

  it('отказ записывается всегда, включая отказ по чтению', () => {
    const session = sessionFor('support', 'acc-pd');
    const outcome = decideCapability({
      session,
      capability: 'read_audit',
      now: at(1000),
      context: context(),
    });
    const event = authorizationOutcome(session, outcome, at(1000));
    expect(event?.kind).toBe('authorization_denied');
    expect(event?.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);
  });
});

describe('в журнал не попадают персональные данные', () => {
  it('идентификаторы непрозрачны: почта и телефон не собираются', () => {
    expect(() => accountId('ivan@example.com')).toThrow();
    expect(() => accountId('Иван Петров')).toThrow();
    expect(() => personId('+995 555 12 34 56')).toThrow();
  });
});
