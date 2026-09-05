import { describe, expect, it } from 'vitest';
import * as app from '@sdelka/app';
import {
  type StepOrigin,
  type World,
  DEAL_EVENT_ORIGINS,
  PLATFORM_SUBJECT,
  TRANCHE_EVENT_ORIGINS,
  WITHDRAWAL_EVENT_ORIGINS,
  advance,
  authorize,
  dealSubject,
  trancheOptions,
  trancheSubject,
  withWithdrawals,
} from '@sdelka/app';
import { AUTH_REASON_KEYS, type Capability, type RoleId } from '@sdelka/auth';
import { money } from '@sdelka/money';
import { STAFF, login } from './support/actors';
import {
  patchFacts,
  receiveExternalPayment,
  receiveTrancheFee,
  requestUnwind,
  requestWithdrawal,
} from './support/acting';
import { DEAL_AMOUNT, GEL, POLICY_VERSION, STATEMENT_SOURCE } from './support/fixtures';
import { toCollected, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const FEE = money(GEL, 300_000n);
const SPARE = money(GEL, 10_000_000n);

/**
 * Полномочия операционной механики расчёта — `ACTORS.md` §5.1.1.
 *
 * ## Что этот файл закрывает
 *
 * До него семь шагов мира — выдача инструкций, отнесение поступления, исход
 * платёжного провайдера, зачисление по выписке, конвертация, довнесение
 * недостачи, заявка на вывод, правка фактов — выполнялись под **чужим**
 * полномочием `create_deal`. Заплатка была названа в коде и держалась ровно на
 * том, что своего полномочия у этих шагов не существовало.
 *
 * Теперь их пять, и у каждого свой носитель. Проверять «полномочие есть» здесь
 * бессмысленно: это утверждение о константе. Каждый сценарий ниже поэтому
 * показывает **пару** — шаг проходит у того, чей он, и отказывает у соседа,
 * которому его не выдали. Дверь, открытая всем, и дверь, запертая для всех,
 * одинаково ничего не доказывают.
 *
 * Отдельно проверяется, что заплатки больше нет: разрешение одного полномочия
 * механики не подставляется в шаг другого — ни компилятором, ни в рантайме.
 */

/** Кому полномочие выдано, а кому — нет. Отказ обязан быть именно «не выдано». */
function grantedTo(world: World, roleId: RoleId, capability: Capability): boolean {
  const actor = { key: `probe:${roleId}`, roleId, accountId: `probe-${roleId}`, personId: `person-probe-${roleId}` };
  const session = login(world, actor);
  const decided = authorize(session.world, session.sessionId, capability, PLATFORM_SUBJECT);
  if (decided.ok) return true;
  // Отказ по другой причине — не ответ на вопрос «выдано ли»: истёкшая сессия
  // или несовместимость отказали бы и носителю полномочия тоже.
  expect(decided.error.reason, `${roleId}:${capability}`).toBe(
    AUTH_REASON_KEYS.capabilityNotGranted,
  );
  return false;
}

describe('подготовка расчёта — prepare_settlement', () => {
  it('у оператора есть, у финансового контролёра нет: готовит и утверждает не один', async () => {
    const { world } = await toReserved({ dealId: 'deal-cap-1', trancheId: 'tranche-cap-1' });
    expect(grantedTo(world, 'operator', 'prepare_settlement')).toBe(true);
    // §6.7, «чего не может никогда ФК» — готовить операцию, которую утверждает.
    expect(grantedTo(world, 'financial_controller', 'prepare_settlement')).toBe(false);
    expect(grantedTo(world, 'head_of_operations', 'prepare_settlement')).toBe(false);
  });

  it('заявку на разбор отката поднимает оператор, а комплаенс-аналитик — нет', async () => {
    const collected = await toCollected({ dealId: 'deal-cap-2', trancheId: 'tranche-cap-2' });
    const request = { reasonKey: 'deal.unwind.registry_refused', evidence: [STATEMENT_SOURCE] };

    expect(() => requestUnwind(collected.world, collected.dealId, request, OPTIONS, STAFF.analyst))
      .toThrow('app.authority.denied');

    const raised = requestUnwind(collected.world, collected.dealId, request, OPTIONS);
    expect(app.dealOf(raised, collected.dealId).unwindReview?.requestedBy).toBe('operator-1');
  });
});

describe('внешний факт платежа — record_bank_outcome', () => {
  it('зачисляет по выписке оператор; ни ФК, ни поддержка, ни сторона', async () => {
    const { world } = await toReserved({ dealId: 'deal-cap-3', trancheId: 'tranche-cap-3' });
    expect(grantedTo(world, 'operator', 'record_bank_outcome')).toBe(true);
    // ФК утверждает выплаты. Соединить в одном лице «объявить, что банк
    // заплатил» и «утвердить выплату» — та концентрация, ради разведения
    // которой полномочий пять, а не одно (`ACTORS.md` §5.1.1 п.1).
    expect(grantedTo(world, 'financial_controller', 'record_bank_outcome')).toBe(false);
    expect(grantedTo(world, 'support', 'record_bank_outcome')).toBe(false);
    expect(grantedTo(world, 'party', 'record_bank_outcome')).toBe(false);
  });

  it('шаг зачисления отказывает финансовому контролёру и проходит у оператора', async () => {
    const collected = await toCollected({ dealId: 'deal-cap-4', trancheId: 'tranche-cap-4' });
    expect(() => receiveExternalPayment(collected.world, collected.buyerKey, SPARE, STAFF.controller))
      .toThrow('app.authority.denied');
    const credited = receiveExternalPayment(collected.world, collected.buyerKey, SPARE);
    expect(credited.journal.entries.length).toBeGreaterThan(collected.world.journal.entries.length);
  });

  it('требует свежего второго фактора, а подготовка расчёта — нет', async () => {
    // Консольная политика даёт пять минут на свежесть фактора и пятнадцать
    // минут простоя. Шесть минут — окно, в котором сессия ещё жива, а фактор
    // уже несвеж: именно здесь видно разницу между двумя полномочиями.
    const { world, dealId } = await toReserved({ dealId: 'deal-cap-5', trancheId: 'tranche-cap-5' });
    const operator = login(world, STAFF.operator);
    const later = advance(operator.world, 6 * 60 * 1000);

    const bank = authorize(later, operator.sessionId, 'record_bank_outcome', PLATFORM_SUBJECT);
    expect(bank.ok).toBe(false);
    if (bank.ok) return;
    expect(bank.error.reason).toBe(AUTH_REASON_KEYS.secondFactorStale);

    // Та же сессия, тот же момент — подготовка расчёта проходит: она ничего не
    // двигает сама, и требовать подтверждение двадцать раз в день значит
    // приучить подтверждать не глядя.
    expect(authorize(later, operator.sessionId, 'prepare_settlement', dealSubject(dealId)).ok)
      .toBe(true);
  });
});

describe('казначейство — operate_treasury', () => {
  it('носитель ровно один — ФК; у оператора его нет', async () => {
    const { world } = await toReserved({ dealId: 'deal-cap-6', trancheId: 'tranche-cap-6' });
    expect(grantedTo(world, 'financial_controller', 'operate_treasury')).toBe(true);
    // Оператор, который и готовит расчёт, и двигает деньги платформы, — одна
    // учётная запись между обязательством и его покрытием.
    expect(grantedTo(world, 'operator', 'operate_treasury')).toBe(false);
    expect(grantedTo(world, 'head_of_operations', 'operate_treasury')).toBe(false);
  });

  it('владелец не двигает деньги платформы: Н6 держится классом действия', async () => {
    const { world } = await toReserved({ dealId: 'deal-cap-7', trancheId: 'tranche-cap-7' });
    // Полномочие класса `release` у роли, видящей маржу, — это Н6 наизнанку.
    // Здесь проверяется первый рубеж (перечень), второй — `roleInvariantViolations`.
    expect(grantedTo(world, 'principal', 'operate_treasury')).toBe(false);
    expect(grantedTo(world, 'auditor', 'operate_treasury')).toBe(false);
  });

  it('комиссию получает ФК; тот же шаг у оператора отказывает', async () => {
    const collected = await toCollected({ dealId: 'deal-cap-8', trancheId: 'tranche-cap-8' });
    expect(() => receiveTrancheFee(collected.world, collected.dealId, collected.trancheId, FEE, STAFF.operator))
      .toThrow('app.authority.denied');
  });
});

describe('заявка на вывод — conduct_withdrawal', () => {
  it('заводит оператор; ФК, который её подписывает, завести её не может', async () => {
    const collected = await toCollected({ dealId: 'deal-cap-9', trancheId: 'tranche-cap-9' });
    const scene = withWithdrawals(receiveExternalPayment(collected.world, collected.buyerKey, SPARE));
    const spec = { withdrawalId: 'wd-cap-9', owner: collected.buyerKey, amount: money(GEL, 1_000_000n) };

    expect(() => requestWithdrawal(scene, spec, STAFF.controller)).toThrow('app.authority.denied');

    const requested = requestWithdrawal(scene, spec);
    expect(app.withdrawalStatusOf(requested, 'wd-cap-9')).toBe('requested');
  });
});

describe('правка фактов транша — patch_tranche_facts', () => {
  it('чёрный ход у оператора, и он не открывается ни аналитику, ни ФК', async () => {
    const { world, trancheId } = await toReserved({ dealId: 'deal-cap-10', trancheId: 'tranche-cap-10' });
    const patch = { evidenceBundleId: 'bundle-cap-10' } as const;

    expect(() => patchFacts(world, trancheId, patch, STAFF.analyst)).toThrow('app.authority.denied');
    expect(() => patchFacts(world, trancheId, patch, STAFF.controller)).toThrow('app.authority.denied');

    const patched = patchFacts(world, trancheId, patch);
    expect(app.trancheOf(patched, trancheId).facts.evidenceBundleId).toBe('bundle-cap-10');
  });
});

describe('заплатки больше нет: разрешения не подставляются друг за друга', () => {
  it('разрешением подготовки расчёта не зачислить деньги по выписке', async () => {
    const collected = await toCollected({ dealId: 'deal-cap-11', trancheId: 'tranche-cap-11' });
    const operator = login(collected.world, STAFF.operator);
    const prepare = authorize(
      operator.world,
      operator.sessionId,
      'prepare_settlement',
      dealSubject(collected.dealId),
    );
    expect(prepare.ok).toBe(true);
    if (!prepare.ok) return;

    expect(() =>
      app.receiveExternalPayment(
        operator.world,
        collected.buyerKey,
        SPARE,
        // @ts-expect-error — зачисление по выписке идёт под `record_bank_outcome`:
        // разрешение подготовки расчёта сюда не подставляется. Рубеж первый —
        // компилятор; если параметризацию снимут, `tsc` уронит файл на
        // неиспользованном подавлении.
        prepare.value,
      ),
      // Рубеж второй — рантайм: разрешение приходит значением, и тип при нём не
      // переживает границу процесса.
    ).toThrow('app.authority.wrong_origin:ledger.top_up');
  });

  it('разрешением подготовки расчёта не поправить факты транша и не двинуть казначейство', async () => {
    const { world, dealId, trancheId } = await toReserved({
      dealId: 'deal-cap-12',
      trancheId: 'tranche-cap-12',
    });
    const operator = login(world, STAFF.operator);
    const prepare = authorize(
      operator.world,
      operator.sessionId,
      'prepare_settlement',
      dealSubject(dealId),
    );
    expect(prepare.ok).toBe(true);
    if (!prepare.ok) return;

    expect(() =>
      app.patchFacts(
        operator.world,
        trancheId,
        { evidenceBundleId: 'bundle-cap-12' },
        // @ts-expect-error — у чёрного хода своё полномочие `patch_tranche_facts`.
        prepare.value,
      ),
    ).toThrow('app.authority.wrong_origin:tranche.patch_facts');

    expect(() =>
      app.receiveTrancheFee(
        operator.world,
        dealId,
        trancheId,
        FEE,
        // @ts-expect-error — комиссия приходит под `operate_treasury`.
        prepare.value,
      ),
    ).toThrow('app.authority.wrong_origin:ledger.fee_received');
  });

  it('`create_deal` остался ровно там, где он не заплатка расчёта', () => {
    // Три события сделки держат `create_deal` по **другой** причине: у роли
    // `oracle_operator`, которой они принадлежат по смыслу, нет соответствия в
    // `AUDIT_ROLES`, и шаг сделки под её полномочием непроводим вовсе
    // (`origins.ts`, оговорка у `filing_registered`). Это расхождение перечней
    // журнала, а не решение о правах, и чинится оно миграцией `sdelka.audit_role`.
    //
    // Всё остальное с этого батча ходит под своими полномочиями. Тест — замок:
    // следующий шаг, которому «пока» подставят `create_deal», уронит его здесь.
    const under = (map: Record<string, readonly StepOrigin[]>): readonly string[] =>
      Object.entries(map)
        .filter(([, origins]) => origins.includes('create_deal'))
        .map(([type]) => type)
        .sort();

    expect(under(DEAL_EVENT_ORIGINS)).toEqual([
      'condition_established',
      'condition_failed',
      'filing_registered',
    ]);
    expect(under(TRANCHE_EVENT_ORIGINS)).toEqual([]);
    expect(under(WITHDRAWAL_EVENT_ORIGINS)).toEqual([]);
  });

  it('событие транша под чужим полномочием механики не проходит', async () => {
    const { world, trancheId } = await toReserved({ dealId: 'deal-cap-13', trancheId: 'tranche-cap-13' });
    const operator = login(world, STAFF.operator);
    const bank = authorize(
      operator.world,
      operator.sessionId,
      'record_bank_outcome',
      trancheSubject(operator.world, trancheId),
    );
    expect(bank.ok).toBe(true);
    if (!bank.ok) return;

    expect(() =>
      app.applyTrancheEvent(
        operator.world,
        trancheId,
        { type: 'instructions_issued', amount: DEAL_AMOUNT },
        // @ts-expect-error — инструкции на оплату выдаются под `prepare_settlement`,
        // а не под внесением внешнего факта: подготовка и факт — разные полномочия.
        bank.value,
        OPTIONS,
      ),
    ).toThrow('app.authority.wrong_origin:tranche.instructions_issued');
  });
});
