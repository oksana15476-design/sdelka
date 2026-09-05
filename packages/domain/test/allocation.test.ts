import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type AllocationAuthorization,
  type ClientAccountFacts,
  type TrancheEvent,
  RejectionCode,
  planAllocationToDeal,
} from '../src/index';
import { AMOUNT, DEAL_ID, PAYER_CLIENT_KEY, TRANCHE_ID, context } from './support/facts';
import { accept, reject, stateAt } from './support/drive';

/**
 * Внутреннее движение свободных денег на свою сделку — `ROADMAP.md` И12.4.
 *
 * Набор проверяет не функцию, а **дорогу**: что разрешение выдаётся только
 * после проверки остатка, что автомат транша его сверяет, и что внутреннее
 * поступление не порождает зачисления. До этого батча проверка остатка
 * существовала и не стояла ни на одной дороге, а движение шло мимо неё —
 * `funds_received` с маршрутом зачисления в опциях приложения.
 */

/** Факты счёта, не называющие владельца: поле опущено, а не занулено. */
const OWNERLESS_FACTS: ClientAccountFacts = Object.freeze({
  free: money('GEL', 3_000_000n),
  locked: [],
  requestedAmount: AMOUNT,
  sourceAccount: null,
  preparedBy: 'operator-1',
  approvals: [],
  activeWithdrawals: 0,
});

function facts(overrides: Partial<ClientAccountFacts> = {}): ClientAccountFacts {
  return { ...OWNERLESS_FACTS, clientKey: PAYER_CLIENT_KEY, ...overrides };
}

function authorize(
  overrides: Partial<ClientAccountFacts> = {},
  request = { dealId: DEAL_ID, trancheId: TRANCHE_ID, amount: AMOUNT },
): AllocationAuthorization {
  const result = planAllocationToDeal(facts(overrides), request);
  if (!result.ok) throw new Error(`unexpected rejection: ${result.error.code}`);
  return result.value;
}

function received(allocation?: AllocationAuthorization, amount = AMOUNT): TrancheEvent {
  // Поле опускается, а не ставится в `undefined`: отсутствие разрешения — это
  // внешний перевод, и оно выражается отсутствием поля.
  const external = {
    type: 'funds_received',
    amount,
    sender: 'buyer-1',
    reference: 'internal-1',
  } as const;
  return allocation === undefined ? external : { ...external, allocation };
}

describe('И12.4: разрешение выдаёт только счёт клиента', () => {
  it('называет владельца, транш и сумму — и ничего сверх', () => {
    const authorization = authorize();
    expect(authorization.clientKey).toBe(PAYER_CLIENT_KEY);
    expect(authorization.dealId).toBe(DEAL_ID);
    expect(authorization.trancheId).toBe(TRANCHE_ID);
    expect(authorization.amount).toEqual(AMOUNT);
  });

  it('не выдаётся, когда факты не называют владельца остатка', () => {
    // Отдельный отказ, а не «остатка не хватает»: остаток здесь есть, но
    // неизвестно чей, и разрешение подтверждало бы само себя — транш применил
    // бы его к тому плательщику, которого назвал вызывающий.
    const result = planAllocationToDeal(OWNERLESS_FACTS, {
      dealId: DEAL_ID,
      trancheId: TRANCHE_ID,
      amount: AMOUNT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(RejectionCode.allocationOwnerUnknown);
  });

  it('не выдаётся, когда свободного остатка не хватает', () => {
    const result = planAllocationToDeal(facts({ free: money('GEL', 999_999n) }), {
      dealId: DEAL_ID,
      trancheId: TRANCHE_ID,
      amount: AMOUNT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.failedGuards).toContain('g_free_balance_sufficient');
  });

  it('строится единственным приведением типа во всём домене', () => {
    // Ambient-ключ делает объект непостроимым кодом; ценность этого держится
    // на том, что приведение к типу ровно одно. Второе — и разрешение снова
    // изготавливает тот, кто им пользуется (тот же приём, что у
    // `DealPartiesAttestation` в учёте).
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const casts = readdirSync(root)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => [...readFileSync(`${root}${name}`, 'utf8').matchAll(
        /as unknown as AllocationAuthorization/gu,
      )].map(() => name));
    expect(casts).toEqual(['allocation.ts']);
  });
});

describe('И12.4: автомат транша сверяет разрешение', () => {
  it('принимает разрешение своего транша', () => {
    const result = accept(stateAt('collecting'), received(authorize()), context());
    expect(result.state.status).toBe('collected');
  });

  it('отвергает разрешение, выданное на другую сделку', () => {
    const other = authorize({}, { dealId: 'deal-other', trancheId: TRANCHE_ID, amount: AMOUNT });
    const error = reject(stateAt('collecting'), received(other), context());
    expect(error.code).toBe(RejectionCode.allocationNotAuthorized);
    expect(error.details.authorizedDealId).toBe('deal-other');
  });

  it('отвергает разрешение, выданное на другой транш той же сделки', () => {
    const other = authorize({}, { dealId: DEAL_ID, trancheId: 'tranche-other', amount: AMOUNT });
    const error = reject(stateAt('collecting'), received(other), context());
    expect(error.code).toBe(RejectionCode.allocationNotAuthorized);
  });

  it('отвергает разрешение по счёту другого клиента', () => {
    // Красная линия №1: свободные деньги одного лица не финансируют
    // обязательство другого. Без сверки владельца транш списал бы с
    // плательщика, чей остаток никто не проверял.
    const stranger = authorize({ clientKey: 'ge.passport.stranger-1' });
    const error = reject(stateAt('collecting'), received(stranger), context());
    expect(error.code).toBe(RejectionCode.allocationNotAuthorized);
    expect(error.details.authorizedClientKey).toBe('ge.passport.stranger-1');
  });

  it('отвергает разрешение на другую сумму', () => {
    const error = reject(
      stateAt('collecting'),
      received(authorize(), money('GEL', 2_000_000n)),
      context(),
    );
    expect(error.code).toBe(RejectionCode.allocationNotAuthorized);
  });
});

describe('И12.4: внутреннее движение не выдумывает поступления', () => {
  it('не зачисляет второй раз то, что уже лежит на счёте клиента', () => {
    // Деньги уже в свободной части счёта этого же клиента. Зачисление здесь
    // дебетовало бы номинальный счёт на сумму, которой банк не получал:
    // покрытие сошлось бы в модели и разошлось с выпиской (красная линия №3).
    const collected = accept(stateAt('collecting'), received(authorize()), context());
    expect(collected.intents.map((intent) => intent.type)).toEqual(['set_deadline', 'notify']);
  });

  it('внешний перевод по-прежнему зачисляется', () => {
    // Обратная сторона: пропуск зачисления обязан быть следствием разрешения, а
    // не новым правилом для всех поступлений.
    const collected = accept(stateAt('collecting'), received(undefined), context());
    const entries = collected.intents.filter((intent) => intent.type === 'post_journal_entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ template: 'funds_received', amount: AMOUNT });
  });

  it('на сделку деньги относит запирание, а не зачисление', () => {
    // Критерий 3 И12.4: списание со свободной части и зачисление на
    // обязательство по сделке Б. Это ровно `lock_funds` на входе в `reserved`,
    // и никакой второй записи для внутреннего движения не нужно.
    const collected = accept(stateAt('collecting'), received(authorize()), context());
    const reserved = accept(collected.state, { type: 'reserve_requested' }, context());
    const entries = reserved.intents.filter((intent) => intent.type === 'post_journal_entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      template: 'lock_funds',
      clientKey: PAYER_CLIENT_KEY,
      dealId: DEAL_ID,
      trancheId: TRANCHE_ID,
    });
  });
});
