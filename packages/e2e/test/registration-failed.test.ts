import { describe, expect, it } from 'vitest';
import { assessRefundDestination, accountFingerprint, payerKeyForDomain } from '@sdelka/compliance';
import { accountBalance, bankNominal, clientFreeAccount, coverage } from '@sdelka/ledger';
import { STAFF } from './support/actors';
import {
  advance,
  dealStatusOf,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyDealEvent,
  applyTrancheEvent,
  approve,
  attachObservation,
  receiveExternalPayment,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  BUYER,
  CADASTRAL_CODE,
  DAY_MS,
  DEAL_AMOUNT,
  GEL,
  NOW,
  POLICY,
  POLICY_VERSION,
  SELLER,
  fp,
  registryUnavailable,
  registryWithoutOwnerChange,
  registryWithoutTransfer,
} from './support/fixtures';
import { openDeal } from './support/open';
import { toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
/** Деньги уже на счёте клиента: откат резерва их туда возвращает, а не зачисляет. */
const ROLLBACK = trancheOptions(POLICY_VERSION, { creditRoute: 'already_on_client_account' });
const DEAL = 'deal-unwound';
const TRANCHE = 'tranche-unwound';

/**
 * Сценарий 2 — регистрация не состоялась: откат по дедлайну и возврат на
 * счёт-источник.
 */
describe('регистрация не состоялась', () => {
  it('откатывает транш по дедлайну и возвращает средства на счёт-источник', async () => {
    const opened = await openDeal({ dealId: DEAL, trancheId: TRANCHE, buyer: BUYER, seller: SELLER });
    let world = opened.world;

    world = applyTrancheEvent(world, TRANCHE, { type: 'instructions_issued' }, OPTIONS).world;
    world = receiveExternalPayment(world, opened.buyerKey, DEAL_AMOUNT);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'funds_received', amount: DEAL_AMOUNT, sender: payerKeyForDomain(BUYER.document), reference: 'payment-1' },
      ROLLBACK,
    ).world;
    world = applyDealEvent(world, DEAL, { type: 'funds_received' }, OPTIONS);
    world = applyTrancheEvent(world, TRANCHE, { type: 'reserve_requested' }, OPTIONS).world;
    world = applyDealEvent(world, DEAL, { type: 'tranches_reserved' }, OPTIONS);
    world = applyDealEvent(
      world,
      DEAL,
      { type: 'filing_registered', applicationId: 'app-2', source: 'party_claim' },
      OPTIONS,
    );

    // Реестр **ответил**, что перехода права нет. Это ответ, а не молчание:
    // `absent` и `unavailable` — разные исходы, и первый годится в основание
    // отказа, а второй только приостанавливает часы (`ORACLE.md` §10).
    expect(registryWithoutTransfer().paidExtract(CADASTRAL_CODE).kind).toBe('absent');
    expect(registryUnavailable().paidExtract(CADASTRAL_CODE).kind).toBe('unavailable');

    world = advance(world, DAY_MS);

    // Ребра `reserved → deadline_reached` в таблице нет — и **намеренно**, а не
    // по недосмотру. Часы этого статуса порождают другое событие:
    // `reserve_expired` (`dueTrancheEvent`, `STATE-MACHINES.md` §5 «отсечка
    // рабочего дня» плюс `CABINETS.md` §3.2 блок 6 «резерв будет снят
    // автоматически и деньги останутся у вас»). `deadline_reached` увёл бы
    // транш прямо в `refund_pending`, минуя обещанное «сделку можно провести
    // заново». Расхождение 9 закрыто селектором часов, а не новым ребром.
    const stuck = rejectTrancheEvent(world, TRANCHE, { type: 'deadline_reached' });
    expect(stuck.code).toBe('domain.transition.not_allowed');

    // Штатный откат идёт в два шага: сначала снятие резерва, потом дедлайн.
    const expired = applyTrancheEvent(world, TRANCHE, { type: 'reserve_expired' }, ROLLBACK);
    world = expired.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('collected');
    // Откат резерва проводки зачисления больше не порождает: она привязана к
    // событию `funds_received`, а не к входу в `collected`. Прежняя редакция
    // придумывала поступление, которого не было, — деньги уже лежали в файле
    // транша, и вторая проводка удваивала и обязательство, и отнесение
    // кастодиана. Ни один инвариант учёта этого не ловил: обеспечение сходилось
    // с обеих сторон.
    expect(expired.transition.intents).not.toContainEqual(
      expect.objectContaining({ type: 'post_journal_entry', template: 'funds_received' }),
    );
    // Подавленное намерение осталось ровно одно — то, что было при приёме
    // средств: деньги пришли раньше отдельной записью.
    expect(world.suppressed.filter((item) => item.trancheId === TRANCHE)).toHaveLength(1);
    // Блокировка реквизитов снята: уходим из резерва не в выплату.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(false);

    // Ручных шагов запирания и расфиксации в этом сценарии больше нет: оба
    // порождает автомат. Утверждения о балансах ниже — те же самые и до
    // минорной единицы, и это и есть доказательство, что перенос верен.
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(20_000_000n);

    world = applyTrancheEvent(world, TRANCHE, { type: 'deadline_reached' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refund_pending');
    // И12.3: о возврате узнают обе стороны, а не только покупатель.
    expect(world.notifications).toContainEqual({ audience: 'both', messageKey: 'tranche.refund_pending.both' });

    world = applyDealEvent(world, DEAL, { type: 'condition_failed' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwinding');

    // Возврат только на счёт-источник, на имя плательщика — без исключений.
    const sourceAccount = accountFingerprint(fp(700));
    const destination = assessRefundDestination(
      {
        sourceAccount,
        sourceHolder: BUYER.document,
        requestedAccount: sourceAccount,
        requestedHolder: BUYER.document,
        sanctionsFrozen: false,
        evidence: [],
      },
      POLICY_VERSION,
      NOW,
    );
    expect(destination.outcome).toBe('clear');

    world = applyTrancheEvent(world, TRANCHE, { type: 'refund_initiated' }, ROLLBACK).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunding');
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      { ...ROLLBACK, payoutResponse: BANK_RESPONSE_SOURCE },
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('refunded');

    world = applyDealEvent(world, DEAL, { type: 'tranches_refunded' }, OPTIONS);
    expect(dealStatusOf(world, DEAL)).toBe('unwound');

    // Деньги ушли с номинального счёта и обязательства перед покупателем нет.
    expect(accountBalance(world.journal, clientFreeAccount(opened.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    const gel = coverage(world.journal).find((item) => item.currency === GEL);
    expect(gel?.difference.minor).toBe(0n);
  });

  it('не выпускает выплату, если новым собственником в выписке значится продавец', async () => {
    const DEAL_B = 'deal-owner-unchanged';
    const TRANCHE_B = 'tranche-owner-unchanged';

    // Худший из случаев: выписка платная, приложена, все пять полей сошлись, и
    // пакет доказательств собран. Не сошлось одно — собственник.
    const reserved = await toReserved({ dealId: DEAL_B, trancheId: TRANCHE_B });
    const answer = registryWithoutOwnerChange().paidExtract(CADASTRAL_CODE);
    if (answer.kind !== 'found') throw new Error('unreachable');
    const extract = answer.value;
    // Сверка идёт по номеру документа, а не по флагу порта: номер в выписке
    // другой, поэтому `reconcileOwner` даёт `refuted` (`CORE.md` Ф7).
    expect(extract.ownerDocumentNumber).toBe('mismatched');
    expect(extract.fields.ownerDocumentNumber).toBe(true);

    let world = attachObservation(reserved.world, TRANCHE_B, extract, 'evidence-owner', POLICY);
    expect(trancheOf(world, TRANCHE_B).facts.observation?.ownerCheck).toBe('refuted');
    expect(trancheOf(world, TRANCHE_B).facts.evidenceBundleId).toBe('evidence-owner');

    // --- Первое ребро пути выплаты ---
    const refused = rejectTrancheEvent(world, TRANCHE_B, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-owner',
      conditionType: 'registration_transfer',
    });
    expect([...refused.failedGuards]).toEqual(['g_owner_is_buyer']);

    // --- Второе ребро: обход через release_blocked закрыт тем же guard'ом ---
    world = applyTrancheEvent(
      world,
      TRANCHE_B,
      { type: 'mismatch_detected', field: 'registry.owner' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE_B)).toBe('release_blocked');
    world = approve(world, TRANCHE_B, STAFF.controller);
    world = approve(world, TRANCHE_B, STAFF.head);
    world = applyTrancheEvent(world, TRANCHE_B, { type: 'approval_added', userId: 'approver-1' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE_B)).toBe('release_pending');

    // Разбор блокировку реквизитов не снимает (§1.5: `release_blocked` внутри
    // периметра резерва), поэтому отказ остаётся ровно один и именно про
    // собственника — прежде здесь стояло восстановление блокировки чёрным
    // ходом, без которого сценарий до своего утверждения не доходил.
    expect(trancheOf(world, TRANCHE_B).beneficiary.locked).toBe(true);
    const refusedAgain = rejectTrancheEvent(world, TRANCHE_B, { type: 'release_authorized' });
    expect([...refusedAgain.failedGuards]).toEqual(['g_owner_is_buyer']);

    // Ни поручения, ни движения денег: средства стоят в файле транша.
    expect(trancheOf(world, TRANCHE_B).payouts).toEqual([]);
    expect(accountBalance(world.journal, clientFreeAccount(reserved.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
  });
});
