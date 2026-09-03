import { describe, expect, it } from 'vitest';
import { payerKeyForDomain, toBeneficiaryLock } from '@sdelka/compliance';
import {
  accountBalance,
  bankNominal,
  clientFreeAccount,
  clientLockedAccount,
  coverageByTranche,
} from '@sdelka/ledger';
import {
  applyTrancheEvent,
  approve,
  attachRegistryExtract,
  holdThirdPartyPayment,
  patchFacts,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '../src/index';
import {
  DEAL_AMOUNT,
  GEL,
  POLICY_VERSION,
  SELLER,
  THIRD_PARTY,
  extractOf,
  registryWithTransfer,
} from './support/fixtures';
import { openDeal } from './support/open';
import { BUYER } from './support/fixtures';

const OPTIONS = trancheOptions(POLICY_VERSION, { taskKind: 'payer_hold' });
const DEAL = 'deal-unfunded-release';
const TRANCHE = 'tranche-unfunded-release';

/**
 * Сценарий 14 — выход из блокировки: путь, за который платят.
 *
 * `collecting → release_blocked → release_pending → paying_out` — тот самый
 * путь, ради которого в §1.4 продублированы guard'ы доказательств. Здесь он
 * пройден целиком, шаг за шагом, и на нём стоят два правила, каждое из которых
 * закрывает свою половину беды:
 *
 * - `g_mismatch_resolved` — из блокировки нельзя выйти, пока расхождение,
 *   которое в неё привело, не снято. Утверждение оператора — это подпись под
 *   решением, а не само решение;
 * - `g_funds_collected` — под траншем должны быть собранные средства. В §1.3
 *   такого guard'а нет: документ считает его само собой разумеющимся, потому
 *   что в `reserved` попадают из `collected`. Но этот путь в `collected` не
 *   заходит вовсе — платёж третьего лица уводит транш в блокировку напрямую,
 *   и до появления правила транш, за которым нет ни лари, доходил до
 *   `paid_out`.
 *
 * Что при этом происходило в учёте: **ничего**. Сумма проводки берётся из
 * собранных средств, и без них намерение просто не порождалось — поручение
 * уходило в банк, а в журнале не оставалось следа. Ни один инвариант учёта
 * такого не видит: записи, которой нет, нечему не сойтись. А деньги на выплату
 * при этом брались бы с номинального счёта, то есть из средств других сделок —
 * красная линия №1.
 */
describe('выход из блокировки', () => {
  it('не выпускает поручение по траншу, за которым нет ни лари', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = applyTrancheEvent(opened.world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;

    // Платёж пришёл, но не от покупателя: деньги физически у нас, обязательства
    // перед покупателем из них не возникает — они висят непознанным
    // поступлением (§3.3, шаг 1).
    world = holdThirdPartyPayment(world, DEAL_AMOUNT);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(THIRD_PARTY.document),
        reference: 'payment-third-party',
      },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    expect(trancheOf(world, TRANCHE).facts.collectedAmount).toBeNull();

    // --- Расхождение не снято: из блокировки не выйти ---
    // Утверждение оператора добавлено, но вопрос «чьи это деньги» не закрыт.
    world = patchFacts(world, TRANCHE, { mismatchResolved: false });
    const stillBlocked = rejectTrancheEvent(world, TRANCHE, {
      type: 'approval_added',
      userId: 'analyst-1',
    });
    expect([...stillBlocked.failedGuards]).toEqual(['g_mismatch_resolved']);
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');

    // --- Расхождение снято: транш возвращается к выпуску поручения ---
    world = patchFacts(world, TRANCHE, { mismatchResolved: true });
    world = applyTrancheEvent(world, TRANCHE, { type: 'approval_added', userId: 'analyst-1' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    // Дальше собрано **всё остальное**: платная выписка приложена, все пять
    // полей сошлись, собственник — покупатель, реквизиты заперты и проверены,
    // две подписи набраны. Это сделано нарочно: отказ ниже обязан быть ровно
    // один и именно про деньги, а не про недостающие документы.
    world = attachRegistryExtract(
      world,
      TRANCHE,
      extractOf(registryWithTransfer(), 'cadastral-unfunded'),
      'evidence-unfunded',
    );
    const beneficiary = trancheOf(world, TRANCHE).beneficiary;
    world = patchFacts(world, TRANCHE, {
      beneficiary: toBeneficiaryLock({ ...beneficiary, locked: true }),
    });
    world = approve(world, TRANCHE, 'approver-1');
    world = approve(world, TRANCHE, 'approver-2');

    // --- И всё-таки поручение не уходит: денег под траншем нет ---
    const unfunded = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect([...unfunded.failedGuards]).toEqual(['g_funds_collected']);
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    expect(trancheOf(world, TRANCHE).payouts).toEqual([]);

    // Учёт молчал бы: файла транша не существует вовсе, ни обязательства, ни
    // средств. Деньги, физически лежащие на номинальном счёте, — чужие и
    // непознанные, и выплата с него была бы выплатой из средств других сделок.
    expect(accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);
    expect(coverageByTranche(world.journal).filter((item) => item.deal.trancheId === TRANCHE)).toEqual([]);
    expect(accountBalance(world.journal, { kind: 'suspense_unidentified' }, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    // Единственный след во всём прогоне — задача оператору. Ни одной проводки
    // по этому траншу журнал не увидел.
    expect(world.tasks.filter((task) => task.trancheId === TRANCHE)).toHaveLength(1);
  });
});
