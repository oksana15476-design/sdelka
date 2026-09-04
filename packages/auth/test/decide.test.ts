import { describe, expect, it } from 'vitest';
import {
  AUTH_REASON_KEYS,
  CLIENT_SESSION_POLICY,
  UNKNOWN_CONTEXT,
  UNKNOWN_FACT,
  decide,
  decideCapability,
} from '../src/index';
import { NOW, actor, at, context, factor, sessionFor } from './support';

describe('решение о полномочии', () => {
  it('выдаёт доказательство, связанное с сессией и человеком', () => {
    const session = sessionFor('operator', 'acc-op', { person: 'per-op' });
    const result = decide(session, 'create_deal', at(60 * 1000), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.capability).toBe('create_deal');
    expect(result.value.sessionId).toBe(session.sessionId);
    expect(result.value.personId).toBe(session.personId);
    expect(result.value.journaled).toBe(true);
  });

  it('умершая сессия отказывает раньше всего остального', () => {
    const session = sessionFor('financial_controller', 'acc-fc', { expiresAt: at(1000) });
    const result = decide(session, 'approve_payout', at(2000), context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sessionExpired);
  });

  it('полномочие, не выданное роли, отвергается и в рантайме', () => {
    // Компилятор ловит это раньше — см. ниже про `@ts-expect-error`. Рантайм —
    // второй рубеж: роль приходит из базы, а типы границу процесса не переживают.
    const session = sessionFor('operator', 'acc-op');
    const result = decideCapability({
      session,
      capability: 'write_beneficiary',
      now: at(60 * 1000),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);
  });

  it('оператор не может ввести реквизиты — вызов не компилируется', () => {
    const session = sessionFor('operator', 'acc-op');
    // @ts-expect-error `write_beneficiary` отсутствует в `OperatorCapability`
    // (`ACTORS.md` §4.2: реквизиты вводит только сторона). Если это перестанет
    // быть ошибкой типов, тест не соберётся — и это ровно то, что нужно.
    decide(session, 'write_beneficiary', NOW, context());
    expect(true).toBe(true);
  });

  it('поддержка не может прочитать реквизиты — вызов не компилируется', () => {
    const session = sessionFor('support', 'acc-pd');
    // @ts-expect-error такого члена нет в `SupportCapability` (`ACTORS.md` §6.9)
    decide(session, 'read_beneficiary', NOW, context());
    expect(true).toBe(true);
  });

  it('владелец не может утвердить выплату — вызов не компилируется', () => {
    const session = sessionFor('principal', 'acc-vl');
    // @ts-expect-error `approve_payout` отсутствует в `PrincipalCapability`
    // (`ACTORS.md` §6.10: ни утвердить, ни снять, ни выплатить)
    decide(session, 'approve_payout', NOW, context());
    expect(true).toBe(true);
  });

  it('оператор оракула не может утвердить выплату — вызов не компилируется', () => {
    const session = sessionFor('oracle_operator', 'acc-or');
    // @ts-expect-error Н2 первым рубежом: полномочия нет в `OracleOperatorCapability`
    decide(session, 'approve_payout', NOW, context());
    expect(true).toBe(true);
  });
});

describe('второй фактор на действии', () => {
  it('утверждение без свежего подтверждения отвергается', () => {
    // Сессия жива и не простаивала: отказ именно по свежести фактора, а не по
    // сроку сессии — иначе тест доказывал бы не то, что заявлено.
    const session = sessionFor('financial_controller', 'acc-fc', {
      factors: [factor('webauthn', NOW)],
      lastSeenAt: at(29 * 60 * 1000),
    });
    const result = decide(session, 'approve_payout', at(30 * 60 * 1000), context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.secondFactorStale);
  });

  it('стоп-кран нажимается без второго фактора', () => {
    const session = sessionFor('operator', 'acc-op', { factors: [] });
    expect(decide(session, 'halt_intake', at(60 * 1000), context()).ok).toBe(true);
  });
});

describe('дежурство', () => {
  it('даёт подтверждение инцидента поверх базовой роли', () => {
    const session = sessionFor('operator', 'acc-op', { onDuty: true });
    const result = decideCapability({
      session,
      capability: 'confirm_incident',
      now: at(1000),
      context: context(),
    });
    expect(result.ok).toBe(true);
  });

  it('без дежурства подтверждения инцидента нет', () => {
    const session = sessionFor('operator', 'acc-op');
    const result = decideCapability({
      session,
      capability: 'confirm_incident',
      now: at(1000),
      context: context(),
    });
    expect(result.ok).toBe(false);
  });

  it('флаг дежурства на роли, которая не дежурит, полномочий не даёт', () => {
    // Проверка `dutyEligible` стояла только на выдаче сессии. Сессия приходит из
    // хранилища, где типов нет: с `onDuty: true` у комплаенс-аналитика стоп-кран
    // выдавался без единой ошибки.
    const session = sessionFor('compliance_analyst', 'acc-ca', { onDuty: true });
    const result = decideCapability({
      session,
      capability: 'confirm_incident',
      now: at(1000),
      context: context(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);
  });

  it('не даёт снять остановку даже дежурному финконтролёру', () => {
    // §7.3: дежурство не имеет ни одного расширяющего полномочия. `lift_halt` у
    // финконтролёра есть по роли — и он остаётся связан Н5.
    const session = sessionFor('financial_controller', 'acc-fc', { onDuty: true });
    const result = decide(
      session,
      'lift_halt',
      at(60 * 1000),
      context({ causedBy: [actor('acc-fc', 'per-fc')] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sodCauserCannotLift);
  });
});

describe('контекст разделения обязанностей обязателен', () => {
  it('решение без контекста не компилируется', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    // Вызов не исполняется: утверждение здесь компиляционное, и до этой правки
    // оно бы не сработало — короткий вызов собирался и утверждал выплату, ни с
    // чем её не разведя. Если четвёртый аргумент снова станет необязательным,
    // `@ts-expect-error` окажется лишним и тест не соберётся.
    const attempt = () => {
      // @ts-expect-error четвёртый аргумент обязателен и умолчания не имеет
      decide(session, 'approve_payout', NOW);
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('запрос без поля контекста не компилируется', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const attempt = () => {
      // @ts-expect-error `context` — обязательное поле `AuthorizationRequest`
      decideCapability({ session, capability: 'approve_payout', now: NOW });
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('утверждение выплаты при невыясненных фактах отказывает', () => {
    // Ровно тот вызов, который раньше проходил молчанием: фактов нет ни одного.
    const session = sessionFor('financial_controller', 'acc-fc');
    const result = decide(session, 'approve_payout', at(60 * 1000), UNKNOWN_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sodContextUnknown);
    expect(result.error.violations.map((item) => item.rule)).toEqual([
      'n1_preparer_not_approver',
      'n2_observer_not_approver',
    ]);
  });

  it('одного выясненного факта из двух не хватает', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const result = decide(
      session,
      'approve_payout',
      at(60 * 1000),
      context({ preparedBy: [actor('acc-op', 'per-op')], observedBy: UNKNOWN_FACT }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sodContextUnknown);
  });

  it('чтение сделки не требует фактов и с пустым знанием проходит', () => {
    const session = sessionFor('operator', 'acc-op');
    expect(decide(session, 'read_deal', at(1000), UNKNOWN_CONTEXT).ok).toBe(true);
  });
});

describe('политику сессии подменить нечем', () => {
  it('решение не принимает политику аргументом', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const attempt = () => {
      // @ts-expect-error пятого аргумента нет: консольной сессии передавали
      // политику кабинета и получали час простоя вместо пятнадцати минут.
      decide(session, 'read_deal', NOW, context(), CLIENT_SESSION_POLICY);
    };
    expect(attempt).toBeTypeOf('function');
  });

  it('простой считается по политике роли, а не по переданной', () => {
    // Двадцать минут простоя: для консоли это смерть сессии, для кабинета — нет.
    const consoleSession = sessionFor('financial_controller', 'acc-fc');
    const client = sessionFor('party', 'acc-pt');
    const later = at(20 * 60 * 1000);
    expect(decide(consoleSession, 'read_deal', later, context()).ok).toBe(false);
    expect(decide(client, 'read_deal', later, context()).ok).toBe(true);
  });
});

describe('разделение обязанностей в решении', () => {
  it('оператор оракула, ставший финконтролёром, не утверждает свою же сделку', () => {
    // Тот же человек, другая учётная запись и другая роль — единственный путь,
    // которым Н2 вообще можно нарушить (§6.6: совмещение по времени).
    const session = sessionFor('financial_controller', 'acc-fc2', { person: 'per-or' });
    const result = decide(
      session,
      'approve_payout',
      at(60 * 1000),
      context({ observedBy: [actor('acc-or', 'per-or')] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sodObserverCannotApprove);
    expect(result.error.violations).toHaveLength(1);
  });

  it('готовивший операцию её не утверждает', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const result = decide(
      session,
      'approve_payout',
      at(60 * 1000),
      context({ preparedBy: [actor('acc-fc', 'acc-fc')] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe(AUTH_REASON_KEYS.sodPreparerCannotApprove);
  });

  it('посторонний финконтролёр утверждает', () => {
    const session = sessionFor('financial_controller', 'acc-fc');
    const result = decide(
      session,
      'approve_payout',
      at(60 * 1000),
      context({ preparedBy: [actor('acc-op', 'per-op')], observedBy: [actor('acc-or', 'per-or')] }),
    );
    expect(result.ok).toBe(true);
  });
});
