import { describe, expect, it } from 'vitest';
import * as app from '@sdelka/app';
import {
  type World,
  actionContextFor,
  advance,
  authorize,
  dealSubject,
  emptyWorld,
  TRANCHE_EVENT_ORIGINS,
  rejectTrancheEvent,
  revokeSession,
  sessionOf,
  statusOfSession,
  touchSession,
  trancheOf,
  trancheOptions,
  trancheSubject,
} from '@sdelka/app';
import { type ActorFact, AUTH_REASON_KEYS, UNKNOWN_FACT } from '@sdelka/auth';
import { applyTrancheEvent as rawApplyTrancheEvent } from '@sdelka/app';
import { conditionAct, partyRef } from './support/fixtures';
import {
  applyDealEvent,
  applyTrancheEvent,
  approve,
  recordConditionAct,
} from './support/acting';
import { type Actor, STAFF, login, party, trancheCapability } from './support/actors';
import {
  CONDITION_ACT_SOURCE,
  DAY_MS,
  DEAL_AMOUNT,
  NOW,
  POLICY_VERSION,
  SELLER,
  SMALL_AMOUNT,
} from './support/fixtures';
import { toReleasePending, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);

/**
 * Полномочия на шагах мира.
 *
 * Каждый сценарий ниже отвечает на один вопрос: **что именно перестанет
 * работать, если снять соответствующую проверку**. Поэтому у всех шесть одна и
 * та же форма: сначала показывается, что шаг проходит, потом — что тот же шаг с
 * испорченным одним условием отказывает, и отказ назван поимённо ключом причины.
 * Утверждение «отказано» без второй половины было бы тавтологией: дверь,
 * запертая всегда, ничего не доказывает.
 */

/** Имена лиц из факта. `UNKNOWN_FACT` — не пустой перечень, и склеивать их нельзя. */
function accountsOf(fact: ActorFact): readonly string[] {
  return fact === UNKNOWN_FACT ? ['<неизвестно>'] : fact.map((item) => item.accountId);
}

/** Учётная запись финансового контролёра, за которой сидит **другой человек**. */
function controllerAs(accountId: string, personId: string): Actor {
  return { key: `fc:${accountId}`, roleId: 'financial_controller', accountId, personId };
}

async function reservedWorld(seed: string): Promise<{ world: World; trancheId: string; dealId: string }> {
  const dealId = `deal-auth-${seed}`;
  const trancheId = `tranche-auth-${seed}`;
  const reserved = await toReserved({ dealId, trancheId });
  return { world: reserved.world, trancheId, dealId };
}

describe('шаг без действующей сессии', () => {
  it('в новом мире сессий нет, и разрешение по несуществующей не выписывается', () => {
    const world = emptyWorld({ now: NOW, chainId: 'sdelka-auth' });
    expect(world.sessions.size).toBe(0);
    expect(() => authorize(world, 'session-nobody', 'create_deal', dealSubject('deal-x'))).toThrow(
      'app.authority.unknown_session:session-nobody',
    );
  });

  it('машинных разрешений наружу пакета не выдают', () => {
    // Часы и источник наблюдения — единственные происхождения без сессии. Их
    // конструкторы живут в `authority.ts` и **не реэкспортируются** из
    // `index.ts`: иначе `clockAuthority()` был бы общедоступным способом подать
    // `deadline_reached` без единой проверки. Проверка держится отсутствием
    // строки в `index.ts`, а отсутствие строки на ревью не видно — поэтому оно
    // закреплено здесь.
    const surface = app as unknown as Record<string, unknown>;
    expect(surface['clockAuthority']).toBeUndefined();
    expect(surface['oracleAuthority']).toBeUndefined();
    // И низкоуровневый вход, принимающий готовые факты разделения обязанностей:
    // именно он позволил бы подставить «никто ничего не делал» и пройти Н1–Н5.
    expect(surface['authorizeWithContext']).toBeUndefined();

    // Переходы мира наружу тоже не выходят. Иначе полномочия обходились бы
    // мимо шагов вовсе: `sealed({ ...world, tranches: withTranche(world, {
    // ...runtime, approvalRecords: [подделка] }) })` набрал бы кворум без
    // единой сессии — правило, которое ни один guard не увидел бы.
    for (const name of ['sealed', 'recorded', 'withTranche', 'withDeal', 'seedWorld']) {
      expect(surface[name], name).toBeUndefined();
    }
  });

  it('часы транша нельзя подменить человеком: событие срока подаёт только tick', async () => {
    const { world, trancheId } = await reservedWorld('clock');
    // Срок ещё не наступил — часы молчат, и это ответ, а не ошибка.
    expect(app.tickTranche(world, trancheId, OPTIONS)).toBeNull();

    // Полномочия, которым человек мог бы разрешить `reserve_expired`, **не
    // существует**: у события единственное происхождение и оно машинное.
    // Отсюда и невозможность подать его сессией: подбирать нечего.
    expect(TRANCHE_EVENT_ORIGINS.reserve_expired).toEqual(['clock']);
    expect(() => trancheCapability({ type: 'reserve_expired' })).toThrow(
      'e2e.actors.machine_only:tranche.reserve_expired',
    );
    expect(() => trancheCapability({ type: 'deadline_reached' })).toThrow(
      'e2e.actors.machine_only:tranche.deadline_reached',
    );

    // А по наступлении срока — проходит, и без всякого актора.
    const later = advance(world, DAY_MS + 1);
    const ticked = app.tickTranche(later, trancheId, OPTIONS);
    expect(ticked?.transition.state.status).toBe('collected');
  });
});

describe('сессия без нужного полномочия', () => {
  it('поддержка не утверждает выплату, финансовый контролёр — утверждает', async () => {
    const { world, trancheId } = await reservedWorld('capability');

    const support = login(world, STAFF.support);
    const denied = authorize(
      support.world,
      support.sessionId,
      'approve_payout',
      trancheSubject(support.world, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.capabilityNotGranted);

    // Та же сессия, то же место, другое лицо — и разрешение выписывается.
    const controller = login(world, STAFF.controller);
    const granted = authorize(
      controller.world,
      controller.sessionId,
      'approve_payout',
      trancheSubject(controller.world, trancheId),
    );
    expect(granted.ok).toBe(true);
  });

  it('разрешение чужого полномочия не собирается — рубеж компиляционный', async () => {
    const { world, trancheId } = await reservedWorld('typed');
    const operator = login(world, STAFF.operator);
    const granted = authorize(
      operator.world,
      operator.sessionId,
      'create_deal',
      trancheSubject(operator.world, trancheId),
    );
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    // Рубеж первый — компилятор. `@ts-expect-error` ниже **обязан** сработать:
    // если завтра параметризацию по событию снимут, `tsc` уронит этот файл на
    // «неиспользованном подавлении», а не промолчит.
    expect(() =>
      rawApplyTrancheEvent(
        operator.world,
        trancheId,
        { type: 'release_authorized' },
        // @ts-expect-error — у выпуска поручения происхождение `approve_payout`,
        // а не `create_deal`: разрешение оператора сюда не подставляется.
        granted.value,
        OPTIONS,
      ),
      // Рубеж второй — рантайм: событие приходит значением, и тип при нём не
      // переживает границу процесса.
    ).toThrow('app.authority.wrong_origin:tranche.release_authorized');
  });

  it('роль в сессии решает, а не роль в записи журнала', async () => {
    const { world, trancheId } = await reservedWorld('journal-role');
    // Оператор не подписывает выплату ни под каким именем: прежде подпись была
    // строкой `approve(world, tranche, 'approver-1')`, и её ставил кто угодно.
    expect(() => approve(world, trancheId, STAFF.operator)).toThrow('app.authority.denied');
    // Запись журнала, которую оставляет разрешённый шаг, несёт **полномочие из
    // гранта**, а не свободную строку: сверить её теперь есть с чем.
    const signed = approve(world, trancheId, STAFF.controller);
    expect(trancheOf(signed, trancheId).approvalRecords.map((item) => item.level)).toEqual([1]);
    expect(trancheOf(signed, trancheId).facts.approvals.map((item) => item.userId)).toEqual([
      'approver-1',
    ]);
  });
});

describe('истёкшая и отозванная сессия', () => {
  it('после абсолютного срока разрешение не выписывается', async () => {
    const { world, trancheId } = await reservedWorld('expired');
    const controller = login(world, STAFF.controller);

    // До срока — выписывается.
    expect(
      authorize(
        controller.world,
        controller.sessionId,
        'approve_payout',
        trancheSubject(controller.world, trancheId),
      ).ok,
    ).toBe(true);

    // Час — запрошенный срок сессии; двигаем часы мира за него.
    const later = advance(controller.world, 2 * 60 * 60 * 1000);
    expect(statusOfSession(later, controller.sessionId)).toBe('expired');
    const denied = authorize(
      later,
      controller.sessionId,
      'approve_payout',
      trancheSubject(later, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sessionExpired);
  });

  it('простой дольше пятнадцати минут отказывает раньше абсолютного срока', async () => {
    const { world, trancheId } = await reservedWorld('idle');
    const controller = login(world, STAFF.controller);
    const later = advance(controller.world, 16 * 60 * 1000);
    // Абсолютный срок ещё не вышел — отказ именно про простой.
    expect(sessionOf(later, controller.sessionId).expiresAt).toBeGreaterThan(later.now);
    expect(statusOfSession(later, controller.sessionId)).toBe('idle');
    const denied = authorize(
      later,
      controller.sessionId,
      'approve_payout',
      trancheSubject(later, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sessionIdle);

    // Отметка активности простой снимает — но абсолютный срок не двигает:
    // продлеваемый абсолютный срок не срок (`@sdelka/auth`, `touch`).
    const touched = touchSession(later, controller.sessionId);
    expect(statusOfSession(touched, controller.sessionId)).toBe('active');
    expect(sessionOf(touched, controller.sessionId).expiresAt).toBe(
      sessionOf(later, controller.sessionId).expiresAt,
    );
  });

  it('отозванная сессия отказывает, хотя срок её не вышел', async () => {
    const { world, trancheId } = await reservedWorld('revoked');
    const controller = login(world, STAFF.controller);
    const revoked = revokeSession(controller.world, controller.sessionId);
    expect(sessionOf(revoked, controller.sessionId).expiresAt).toBeGreaterThan(revoked.now);
    expect(statusOfSession(revoked, controller.sessionId)).toBe('revoked');
    const denied = authorize(
      revoked,
      controller.sessionId,
      'approve_payout',
      trancheSubject(revoked, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sessionRevoked);
  });
});

describe('разделение обязанностей на фактах мира', () => {
  it('готовивший транш не утверждает выплату — по человеку, а не по учётной записи', async () => {
    const { world, trancheId } = await reservedWorld('sod-n1');

    // Готовившего мир знает сам: имя положило туда разрешение оператора.
    const context = actionContextFor(world, trancheSubject(world, trancheId));
    expect(context.preparedBy).not.toBe(UNKNOWN_FACT);
    expect(accountsOf(context.preparedBy)).toEqual(['operator-1']);

    // Учётная запись **другая**, человек — тот же. `ACTORS.md` §6.6 прямо
    // предусматривает совмещение должностей по времени, и правило, стоящее
    // только на учётной записи, в этот день перестаёт работать молча.
    const sameHuman = controllerAs('approver-1x', 'person-operator-1');
    const session = login(world, sameHuman);
    const denied = authorize(
      session.world,
      session.sessionId,
      'approve_payout',
      trancheSubject(session.world, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sodPreparerCannotApprove);
    expect(denied.error.violations.map((item) => item.rule)).toContain('n1_preparer_not_approver');

    // Тот же ФК, но другой человек — проходит. Без этой строки предыдущая
    // доказывала бы только, что дверь заперта всем.
    const other = login(world, controllerAs('approver-1y', 'person-approver-1y'));
    expect(
      authorize(other.world, other.sessionId, 'approve_payout', trancheSubject(other.world, trancheId))
        .ok,
    ).toBe(true);
  });

  it('вносивший наблюдение не утверждает выплату по той же сделке', async () => {
    const dealId = 'deal-auth-sod-n2';
    const trancheId = 'tranche-auth-sod-n2';
    const pending = await toReleasePending({ dealId, trancheId });

    const context = actionContextFor(pending.world, trancheSubject(pending.world, trancheId));
    expect(accountsOf(context.observedBy)).toEqual(['oracle-1']);

    const sameHuman = controllerAs('approver-2x', 'person-oracle-1');
    const session = login(pending.world, sameHuman);
    const denied = authorize(
      session.world,
      session.sessionId,
      'approve_payout',
      trancheSubject(session.world, trancheId),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sodObserverCannotApprove);

    // Штатный контролёр по тому же траншу — проходит.
    expect(() => approve(pending.world, trancheId, STAFF.controller)).not.toThrow();
  });

  it('вызвавший остановку её не снимает', async () => {
    const { world, dealId } = await reservedWorld('sod-n5');
    let frozen = applyDealEvent(world, dealId, { type: 'tranches_reserved' }, OPTIONS);
    frozen = applyDealEvent(
      frozen,
      dealId,
      { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'analyst-1' },
      OPTIONS,
      STAFF.analyst,
    );

    // Мир знает, чьё действие остановило сделку: след положило само разрешение.
    const context = actionContextFor(frozen, dealSubject(dealId));
    expect(accountsOf(context.causedBy)).toEqual(['analyst-1']);

    const causer = login(frozen, STAFF.analyst);
    const denied = authorize(causer.world, causer.sessionId, 'lift_block', dealSubject(dealId));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sodCauserCannotLift);

    // Другой аналитик — проходит: правило разводит людей, а не запрещает всем.
    const other = login(frozen, STAFF.analyst2);
    expect(authorize(other.world, other.sessionId, 'lift_block', dealSubject(dealId)).ok).toBe(true);
  });

  it('«неизвестно» отказывает так же, как нарушение, и не читается как «никто»', async () => {
    const { world, trancheId } = await reservedWorld('sod-unknown');
    const controller = login(world, STAFF.controller);

    // Предмет, о котором мир не знает ничего: сделки с таким именем нет.
    const blank = actionContextFor(controller.world, dealSubject('deal-nonexistent'));
    expect(blank.preparedBy).toBe(UNKNOWN_FACT);
    expect(blank.observedBy).toBe(UNKNOWN_FACT);
    const denied = authorize(
      controller.world,
      controller.sessionId,
      'approve_payout',
      dealSubject('deal-nonexistent'),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.reason).toBe(AUTH_REASON_KEYS.sodContextUnknown);

    // По существующему траншу тот же вызов проходит: отказ был про незнание, а
    // не про роль.
    expect(
      authorize(
        controller.world,
        controller.sessionId,
        'approve_payout',
        trancheSubject(controller.world, trancheId),
      ).ok,
    ).toBe(true);
  });

  it('акт об условии совершает названный в нём получатель, и никто другой', async () => {
    const { world, dealId, trancheId } = await reservedWorld('act');
    const act = conditionAct(partyRef(SELLER));

    // Полномочие у стороны есть — но у **другой** стороны.
    expect(() =>
      recordConditionAct(
        world,
        dealId,
        trancheId,
        act,
        CONDITION_ACT_SOURCE,
        POLICY_VERSION,
        party('party-buyer'),
      ),
    ).toThrow('app.authority.actor_mismatch:condition_act.recipient');

    // Получатель, названный в акте, — проходит.
    expect(() =>
      recordConditionAct(world, dealId, trancheId, act, CONDITION_ACT_SOURCE, POLICY_VERSION),
    ).not.toThrow();
  });
});

describe('кворум утверждений', () => {
  it('две подписи одного уровня набирают guard домена и не набирают кворум', async () => {
    const dealId = 'deal-auth-quorum';
    const trancheId = 'tranche-auth-quorum';
    const pending = await toReleasePending({ dealId, trancheId });

    // 200 000 ₾ — вторая ступень: уровень 1 плюс уровень 2.
    expect(DEAL_AMOUNT.minor).toBe(20_000_000n);

    // Два **разных** финансовых контролёра: разные учётные записи, разные люди,
    // ни один не готовил транш.
    let world = approve(pending.world, trancheId, STAFF.controller);
    world = approve(world, trancheId, controllerAs('approver-1z', 'person-approver-1z'));

    // Guard домена доволен: он считает имена, и имён два.
    expect(() => rejectTrancheEvent(world, trancheId, { type: 'release_authorized' })).toThrow(
      'app.tranche.unexpected_transition',
    );

    // Кворум — нет: второго уровня утверждения не набрано. Ровно тот случай,
    // который `ACTORS.md` §0 п.3 называет невыполненным обещанием: две учётные
    // записи — не двое утверждающих.
    expect(() => applyTrancheEvent(world, trancheId, { type: 'release_authorized' }, OPTIONS)).toThrow(
      'app.quorum.not_met:auth.quorum.level_two_missing',
    );

    // Тот же транш с подписью руководителя операций — проходит.
    const withLevelTwo = approve(pending.world, trancheId, STAFF.controller);
    const complete = approve(withLevelTwo, trancheId, STAFF.head);
    expect(
      applyTrancheEvent(complete, trancheId, { type: 'release_authorized' }, OPTIONS).transition.state
        .status,
    ).toBe('paying_out');
  });

  it('на первой ступени одной подписи уровня 1 достаточно, а нуля — никогда', async () => {
    const dealId = 'deal-auth-quorum-small';
    const trancheId = 'tranche-auth-quorum-small';
    const pending = await toReleasePending({ dealId, trancheId, amount: SMALL_AMOUNT });

    // Ноль подписей отсекается ещё на различности утверждающих: пустого набора
    // «двоих» не бывает. Ключ назван поимённо — если проверка исчезнет, здесь
    // изменится не только факт отказа, но и его причина.
    expect(() =>
      applyTrancheEvent(pending.world, trancheId, { type: 'release_authorized' }, OPTIONS),
    ).toThrow('app.quorum.not_met:auth.quorum.approvers_not_distinct');

    const signed = approve(pending.world, trancheId, STAFF.controller);
    expect(
      applyTrancheEvent(signed, trancheId, { type: 'release_authorized' }, OPTIONS).transition.state
        .status,
    ).toBe('paying_out');
  });

  it('одна подпись уровня 2 первую ступень не закрывает', async () => {
    const dealId = 'deal-auth-quorum-head';
    const trancheId = 'tranche-auth-quorum-head';
    const pending = await toReleasePending({ dealId, trancheId, amount: SMALL_AMOUNT });

    // Руководитель операций старше финансового контролёра — и всё-таки ступень
    // «одна подпись» в одиночку не закрывает: уровень 2 определён документом
    // как **второе** утверждение (`@sdelka/auth`, `evaluateQuorum`).
    const signed = approve(pending.world, trancheId, STAFF.head);
    expect(() => applyTrancheEvent(signed, trancheId, { type: 'release_authorized' }, OPTIONS)).toThrow(
      'app.quorum.not_met:auth.quorum.level_one_missing',
    );
  });
});
