import { describe, expect, it } from 'vitest';
import { auditRef, reconstructPayout } from '@sdelka/audit';
import { compareNames, payerKeyForDomain, reconcileOwner } from '@sdelka/compliance';
import { payoutIdempotencyKey, reduceTranche } from '@sdelka/domain';
import { money } from '@sdelka/money';
import { accountBalance, bankNominal, bankOperating, clientFreeAccount, clientLockedAccount, coverage } from '@sdelka/ledger';
import { STAFF } from './support/actors';
import {
  contextFor,
  dealFactsOf,
  dealStatusOf,
  feeForTranche,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyDealEvent,
  applyObservationEvent,
  applyTrancheEvent,
  approve,
  convertBalance,
  receiveExternalPayment,
  receivePaidExtract,
  receiveTrancheFee,
} from './support/acting';
import {
  APPLICATION_ID,
  BANK_RESPONSE_SOURCE,
  BUYER,
  CADASTRAL_CODE,
  CREATED_ON,
  DEAL_AMOUNT,
  DEAL_AMOUNT_USD,
  FX_RATES,
  GEL,
  POLICY,
  POLICY_VERSION,
  SELLER,
  bankPort,
  cardOf,
  registryWithApplicationCard,
  registryWithTransfer,
  settledOutcome,
} from './support/fixtures';
import { openDeal } from './support/open';
const OPTIONS = trancheOptions(POLICY_VERSION);
const DEAL = 'deal-happy';
const TRANCHE = 'tranche-happy';
/**
 * Сценарий 1 — счастливый путь целиком.
 *
 * Акт об условии → приём средств → конвертация → резерв → подтверждение
 * регистрации по платной выписке → два утверждения → расщеплённая выплата
 * вместе с выводом комиссии на операционный счёт → восстановление основания
 * выплаты из журнала.
 */
describe('счастливый путь', () => {
  it('проходит от заведения сделки до paid_out и восстанавливается из журнала аудита', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    expect(opened.admission).toBe('clear');
    let world = opened.world;
    const checksAtStart = world.checks;
    // Акт получателя записан до денег: без него приём средств не открывается.
    world = applyTrancheEvent(world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collecting');
    // --- Приём средств: покупатель платит в долларах ---
    world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT_USD);
    // --- Конвертация: клиенту по клиентскому курсу, спред — на операционный ---
    // Целевой валюты в аргументах нет: её несёт курс (`FxRates.quote`).
    const conversion = convertBalance(
      world,
      opened.buyerKey,
      'fx-happy-1',
      DEAL_AMOUNT_USD,
      FX_RATES,
      CREATED_ON,
    );
    world = conversion.world;
    expect(conversion.converted.target.minor).toBe(20_000_000n);
    // 8 000 долларов·255/100 − 20 000 000 тетри = 400 000 тетри спреда.
    expect(conversion.spread.amount.minor).toBe(400_000n);
    // Деньги уже на свободной части счёта клиента: событие транша их только
    // относит на сделку, повторного зачисления быть не должно.
    const collected = applyTrancheEvent(
      world,
      TRANCHE,
      {
        type: 'funds_received',
        amount: DEAL_AMOUNT,
        sender: payerKeyForDomain(BUYER.document),
        reference: 'payment-1',
      },
      trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' }),
    );
    world = collected.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    expect(world.suppressed).toEqual([
      { trancheId: TRANCHE, template: 'funds_received', reasonKey: 'app.ledger.funds_already_credited' },
    ]);
    world = applyDealEvent(world, DEAL, { type: 'funds_received' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('funding');
    // --- Резерв ---
    world = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('reserved');
    // Реквизиты получателя заперты входом в резерв, а не решением оператора.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);
    // Запирание средств под транш — намерение входа в `reserved`, а не шаг
    // приложения. Ручного вызова здесь больше нет: тест, забывший его позвать,
    // получал необеспеченный транш, а позвавший дважды — двойную проводку.
    expect(
      accountBalance(world.journal, clientLockedAccount(opened.buyerKey, DEAL, TRANCHE), GEL).minor,
    ).toBe(20_000_000n);
    world = applyDealEvent(world, DEAL, { type: 'tranches_reserved' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('funded');
    // --- Подача заявления: сторона называет номер, карточка его подтверждает ---
    world = applyObservationEvent(world, TRANCHE, { type: 'observation_started' }, OPTIONS).world;
    world = applyObservationEvent(
      world,
      TRANCHE,
      { type: 'filing_claimed', applicationId: APPLICATION_ID, byParty: BUYER.partyId },
      OPTIONS,
    ).world;
    expect(dealStatusOf(world, DEAL)).toBe('filed');
    // Номер, названный стороной, автооткрата не запрещает: иначе сторона
    // управляет нашим дедлайном одним сообщением (И3.2, критерий 1).
    expect(dealFactsOf(world, DEAL).filings.map((filing) => filing.source)).toEqual(['party_claim']);
    const card = cardOf(registryWithApplicationCard(), APPLICATION_ID);
    world = applyObservationEvent(
      world,
      TRANCHE,
      {
        type: 'filing_card_observed',
        applicationId: card.applicationId,
        cadastralCode: card.cadastralCode,
        applicationStatus: card.applicationStatus,
      },
      OPTIONS,
    ).world;
    // Источник факта усилился, а состояние сделки не сдвинулось: `filed` — это
    // «заявление подано», а не «подано ещё раз».
    expect(dealFactsOf(world, DEAL).filings.map((filing) => filing.source)).toEqual([
      'application_card',
    ]);
    expect(dealStatusOf(world, DEAL)).toBe('filed');
    world = applyObservationEvent(world, TRANCHE, { type: 'statutory_term_elapsed' }, OPTIONS).world;
    world = applyObservationEvent(
      world,
      TRANCHE,
      { type: 'extract_ordered', cost: money(GEL, 1_000n) },
      OPTIONS,
    ).world;

    // --- Подтверждение регистрации по платной выписке ---
    const answer = registryWithTransfer().paidExtract(CADASTRAL_CODE);
    expect(answer.kind).toBe('found');
    if (answer.kind !== 'found') throw new Error('unreachable');
    const extract = answer.value;
    // Сверка собственника ведётся по номеру документа: имя — вторичный сигнал.
    // Здесь она проверяется на том же входе, который использует приложение, —
    // раньше `ownerDocumentNumber` приложение выбрасывало, и эта сверка жила
    // только в теле теста.
    const owner = reconcileOwner(
      extract.ownerDocumentNumber,
      compareNames(extract.ownerNames, BUYER.names, {
        strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp,
      }),
    );
    expect(owner.outcome).toBe('established');
    const observed = receivePaidExtract(
      world,
      TRANCHE,
      extract,
      'evidence-bundle-1',
      POLICY,
      OPTIONS,
    );
    world = observed.world;
    // Машина наблюдения и автомат транша вывели одно и то же из одного
    // документа: вердикт `matched`, транш в `release_pending`.
    expect(observed.state.status).toBe('matched');
    expect(trancheOf(world, TRANCHE).facts.observation?.ownerCheck).toBe('established');
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    world = applyDealEvent(world, DEAL, { type: 'condition_established', conditionType: 'registration_transfer' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('settling');
    // ⚠ Тест-надгробие. Если приложение материализует поручение уже на входе в
    // `release_pending` (намерение `build_payout_instruction`), его начальный
    // статус `created` попадает в активные, и `g_no_active_payout` запирает
    // транш в `release_pending` навсегда. Отчёт, расхождение 6.
    const withEagerPayout = contextFor(world, trancheOf(world, TRANCHE));
    const deadlocked = reduceTranche(
      trancheOf(world, TRANCHE).state,
      { type: 'release_authorized' },
      { ...withEagerPayout, facts: { ...withEagerPayout.facts, activePayouts: 1 } },
    );
    expect(deadlocked.ok).toBe(false);
    if (!deadlocked.ok) {
      expect(deadlocked.error.failedGuards).toContain('g_no_active_payout');
    }
    // --- Два утверждения: автоматического релиза нет при любой сумме ---
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);
    // --- Банк подтвердил ---
    const bank = bankPort({ outcomes: [settledOutcome()], reconciliation: null });
    const outcome = bank.outcomeFor(payoutIdempotencyKey(TRANCHE));
    expect(outcome.outcome).toBe('settled');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE }),
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');
    // --- Расщеплённая выплата и комиссия на операционный счёт ---
    const fee = feeForTranche(world, TRANCHE, DEAL_AMOUNT);
    expect(fee.minor).toBe(300_000n);
    expect(accountBalance(world.journal, clientFreeAccount(opened.sellerKey), GEL).minor).toBe(19_700_000n);
    // Доход признан **начислением**, отдельной записью: до E14 это была та же
    // запись, что и расчёт, и «начислено», «удержано», «получено» были одним
    // числом.
    expect(accountBalance(world.journal, { kind: 'fee_income' }, GEL).minor).toBe(300_000n);
    // Красная линия №2: комиссия не осталась на номинальном счёте — и никакого
    // отдельного шага вывода для этого не понадобилось. Расчёт вывел её сам, в
    // той же записи; ручной `sweepFee` из приложения удалён.
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(19_700_000n);
    // На операционном счёте пока только спред: он признаётся доходом в момент
    // конвертации и приходит сразу, а комиссия идёт через транзит.
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(400_000n);
    world = receiveTrancheFee(world, DEAL, TRANCHE, fee);
    // Спред 400 000 плюс комиссия 300 000.
    expect(accountBalance(world.journal, bankOperating(GEL), GEL).minor).toBe(700_000n);
    world = applyDealEvent(world, DEAL, { type: 'tranches_settled' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('settled');
    // Покрытие ровно единица: обязательство перед продавцом и деньги на
    // номинальном счёте сошлись до тетри.
    const gel = coverage(world.journal).find((item) => item.currency === GEL);
    expect(gel?.difference.minor).toBe(0n);
    expect(gel?.ratio).toEqual({ numerator: 1n, denominator: 1n });
    // Инварианты проверялись после каждого шага, а не один раз в конце.
    expect(world.checks - checksAtStart).toBeGreaterThan(15);
    // --- Журнал аудита восстанавливает основание выплаты ---
    const dossier = reconstructPayout(world.chain, [], auditRef('payout', payoutIdempotencyKey(TRANCHE)));
    expect(dossier.integrity.intact).toBe(true);
    expect(dossier.ordered).not.toBeNull();
    expect(dossier.result).not.toBeNull();
    const kinds = dossier.evidence.map((item) => item.sourceKind);
    // На основании какого документа: акт получателя об условии и платная выписка.
    expect(kinds).toContain('condition_act');
    expect(kinds).toContain('registry_extract');
    expect(kinds).toContain('payment_provider_response');
    // По каким правилам: версия политики, действовавшая в момент решения.
    expect(dossier.policies).toContain(POLICY_VERSION as unknown as string);
    // Кем и когда: решения комплаенса с актором и меткой времени.
    expect(dossier.decisions.length).toBeGreaterThan(0);
  });
});
