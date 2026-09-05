import { describe, expect, it } from 'vitest';
import {
  payoutIdempotencyKey,
  refundIdempotencyKey,
  reducePayout,
} from '@sdelka/domain';
import {
  accountBalance,
  bankNominal,
  clientFreeAccount,
  clientLockedAccount,
} from '@sdelka/ledger';
import {
  invariantViolations,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { applyTrancheEvent } from './support/acting';
import { BANK_RESPONSE_SOURCE, GEL, POLICY_VERSION, STATEMENT_SOURCE } from './support/fixtures';
import { toPayingOut } from './support/paths';

/** Явный ответ банка: у `settled` и `rejected` он обязателен по типу записи. */
const ANSWERED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });
/** Ответа нет — только это и ведёт в «неизвестно» (`STATE-MACHINES.md` §2.2). */
const SILENT = trancheOptions(POLICY_VERSION, {
  payoutResponse: null,
  payoutReasonKey: 'payout.timeout',
});
/** Сверка с выпиской: источник другой, и это видно в журнале аудита. */
const STATEMENT = trancheOptions(POLICY_VERSION, { payoutResponse: STATEMENT_SOURCE });
const PLAIN = trancheOptions(POLICY_VERSION);

/**
 * Сценарий 21 — банк отказал, деньги идут покупателю.
 *
 * Красная линия №7: состояние по умолчанию при бездействии — возврат
 * покупателю, а не удержание. Из неё следует требование, которое до этого
 * батча не выполнялось: **у возврата обязана быть дорога при любом исходе
 * банка**, включая исход по самому возврату.
 *
 * Что было сломано. У возврата не было собственной записи поручения: вход в
 * `refunding` не порождал ничего, и приложение отдавало ответ банка последней
 * выплате транша. У транша, попавшего в возврат обычным путём — «банк отклонил
 * расчёт получателю» — последней выплатой был **отклонённый расчёт**, то есть
 * терминальное состояние машины выплаты. Любое подтверждение возврата
 * отвергалось как `domain.state.terminal`, транш вставал в `refunding`
 * навсегда, и двадцать миллионов тетри оставались заперты в файле транша.
 * Единственным терминальным выходом оставалось списание в невостребованные —
 * то есть при бездействии система приходила не к возврату, а к удержанию.
 *
 * Доменное ребро `refunding → refunded` при этом существовало, спека его
 * требовала, guard'ов на нём не было. Механизм был построен, дороги к нему не
 * было.
 */
describe('банк отказал по расчёту: возврат покупателю', () => {
  it('доводит деньги до покупателя и не трогает запись отклонённого расчёта', async () => {
    const path = await toPayingOut({
      dealId: 'deal-refund-after-reject',
      trancheId: 'tranche-refund-after-reject',
    });
    const deal = 'deal-refund-after-reject';
    const tranche = 'tranche-refund-after-reject';
    let world = path.world;
    expect(trancheStatusOf(world, tranche)).toBe('paying_out');

    // --- Банк отвечает отказом: явный ответ, а не молчание ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'rejected' },
      ANSWERED,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('release_blocked');
    const release = trancheOf(world, tranche).payouts.at(-1);
    expect(release?.leg).toBe('release');
    expect(release?.status).toBe('rejected');

    // Деньги никуда не ушли: расчёт записывается только на входе в `paid_out`.
    const file = clientLockedAccount(path.buyerKey, deal, tranche);
    expect(accountBalance(world.journal, file, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);

    // --- Оператор ведёт транш в возврат ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'refund_requested', reason: 'bank.rejected_payout' },
      PLAIN,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('refund_pending');
    world = applyTrancheEvent(world, tranche, { type: 'refund_initiated' }, PLAIN).world;
    expect(trancheStatusOf(world, tranche)).toBe('refunding');

    // У возврата **своя** запись поручения и **свой** ключ. Общий с расчётом
    // ключ дал бы банку право погасить возврат как повтор уже обработанного.
    const payouts = trancheOf(world, tranche).payouts;
    expect(payouts).toHaveLength(2);
    expect(payouts.at(-1)?.leg).toBe('refund');
    expect(payouts.at(-1)?.status).toBe('submitted');
    expect(payouts.at(-1)?.idempotencyKey).toBe(refundIdempotencyKey(tranche));
    expect(payouts.at(-1)?.idempotencyKey).not.toBe(payoutIdempotencyKey(tranche));
    // Отклонённый расчёт остался отклонённым: исход возврата — не его исход.
    expect(payouts.at(0)?.status).toBe('rejected');

    // --- Банк подтверждает возврат ---
    // Раньше эта строка бросала `app.payout.rejected:domain.state.terminal`.
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'settled' },
      ANSWERED,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('refunded');

    // --- Деньги у покупателя, на номинальном счёте ноль ---
    expect(accountBalance(world.journal, file, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(path.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(invariantViolations(world)).toEqual([]);

    // Исход записан **тому** поручению, которому адресован.
    const after = trancheOf(world, tranche).payouts;
    expect(after.map((item) => [item.leg, item.status])).toEqual([
      ['release', 'rejected'],
      ['refund', 'settled'],
    ]);
    const results = world.chain.records.filter((record) => record.body.kind === 'payout_result');
    expect(results.map((record) => record.subject.id)).toEqual([
      payoutIdempotencyKey(tranche),
      refundIdempotencyKey(tranche),
    ]);
  });

  /**
   * Отказ банка **по возврату** — не тупик: транш уходит в разбор человеком,
   * и оттуда возврат назначается заново. Дорога к покупателю есть при обоих
   * явных исходах банка.
   */
  it('после отказа по возврату повторяет его через разбор человеком и доводит деньги', async () => {
    const deal = 'deal-refund-twice';
    const tranche = 'tranche-refund-twice';
    const path = await toPayingOut({ dealId: deal, trancheId: tranche });
    let world = path.world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'rejected' },
      ANSWERED,
    ).world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'refund_requested', reason: 'bank.rejected_payout' },
      PLAIN,
    ).world;
    world = applyTrancheEvent(world, tranche, { type: 'refund_initiated' }, PLAIN).world;

    // --- Банк отклоняет и возврат ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'rejected' },
      ANSWERED,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('release_blocked');
    // Отвергнутый возврат не оставляет в журнале ни одной записи: не произошло
    // ничего, и деньги по-прежнему заперты под траншем.
    const file = clientLockedAccount(path.buyerKey, deal, tranche);
    expect(accountBalance(world.journal, file, GEL).minor).toBe(20_000_000n);
    // Задача дежурному есть: выход из `release_blocked` зависит от человека.
    expect(world.tasks.filter((task) => task.trancheId === tranche).length).toBeGreaterThan(0);

    // --- Человек назначает возврат заново ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'refund_requested', reason: 'bank.rejected_refund' },
      PLAIN,
    ).world;
    world = applyTrancheEvent(world, tranche, { type: 'refund_initiated' }, PLAIN).world;
    expect(trancheStatusOf(world, tranche)).toBe('refunding');
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'settled' },
      ANSWERED,
    ).world;

    // --- Деньги дошли ---
    expect(trancheStatusOf(world, tranche)).toBe('refunded');
    expect(accountBalance(world.journal, file, GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, clientFreeAccount(path.buyerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(invariantViolations(world)).toEqual([]);
    expect(trancheOf(world, tranche).payouts.map((item) => [item.leg, item.status])).toEqual([
      ['release', 'rejected'],
      ['refund', 'rejected'],
      ['refund', 'settled'],
    ]);
  });
});

/**
 * Красная линия №8 на ноге возврата: «неизвестно» — легальное состояние,
 * повтор из него запрещён, выход только через сверку.
 *
 * Проверяется именно на возврате, потому что до этого батча у возврата не было
 * собственной машины выплаты вовсе: правило существовало ровно для одной ноги.
 */
describe('возврат без ответа банка', () => {
  it('стоит в refunding, не выпускает поручение заново и выходит только сверкой', async () => {
    const deal = 'deal-refund-unknown';
    const tranche = 'tranche-refund-unknown';
    const path = await toPayingOut({ dealId: deal, trancheId: tranche });
    let world = path.world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'rejected' },
      ANSWERED,
    ).world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'refund_requested', reason: 'bank.rejected_payout' },
      PLAIN,
    ).world;
    world = applyTrancheEvent(world, tranche, { type: 'refund_initiated' }, PLAIN).world;
    const entriesBefore = world.journal.entries.length;

    // --- Ответа нет ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'unknown' },
      SILENT,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('refunding');
    const unknown = trancheOf(world, tranche).payouts.at(-1);
    expect(unknown?.leg).toBe('refund');
    expect(unknown?.status).toBe('unknown');
    // Ни одной проводки: деньги, возможно, ушли, но мы этого не знаем.
    expect(world.journal.entries).toHaveLength(entriesBefore);
    // Поручение не выпущено заново: самопереход `refunding → refunding`
    // внутренний, действий входа при нём нет.
    expect(world.reissuedPayouts).toEqual([]);
    expect(trancheOf(world, tranche).payouts).toHaveLength(2);

    // --- Повтор запрещён отсутствием перехода, а не проверкой в обработчике ---
    if (unknown === undefined) throw new Error('unreachable');
    expect(reducePayout(unknown, { type: 'payout_submitted' }).ok).toBe(false);

    // --- Ответ банка мимо сверки не принимается ---
    // Из `unknown` у машины выплаты нет ребра `provider_confirms`: «банк
    // перезвонил и сказал, что всё прошло» — не факт выписки.
    expect(() =>
      applyTrancheEvent(world, tranche, { type: 'payout_result', outcome: 'settled' }, ANSWERED),
    ).toThrow('app.payout.rejected:domain.transition.not_allowed');
    expect(() =>
      applyTrancheEvent(world, tranche, { type: 'payout_result', outcome: 'rejected' }, ANSWERED),
    ).toThrow('app.payout.rejected:domain.transition.not_allowed');
    expect(trancheStatusOf(world, tranche)).toBe('refunding');

    // --- Выход только через сверку с выпиской ---
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'reconciliation_resolved', outcome: 'settled' },
      STATEMENT,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('refunded');
    expect(trancheOf(world, tranche).payouts.at(-1)?.status).toBe('settled');
    expect(
      accountBalance(world.journal, clientFreeAccount(path.buyerKey), GEL).minor,
    ).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(0n);
    expect(invariantViolations(world)).toEqual([]);
  });

  /**
   * Вторая половина той же красной линии, и она про **чужую** ногу.
   *
   * Ответ банка по расчёту потерян — деньги, возможно, уже у получателя.
   * Единственный выход из `paying_out` мимо ответа — заморозка, а разморозка
   * из неё ведёт только в `release_blocked` (`freeze.ts`). Оттуда оператор
   * вправе назначить возврат — и вот тут возврат обязан **не начаться**: иначе
   * одни и те же деньги уходят дважды, и обнаружится это только покрытием на
   * конец банковского дня.
   *
   * Раньше он начинался. Более того, `reconciliation_resolved(settled)` на
   * таком транше проходил и молча переводил в `settled` запись **расчёта
   * продавцу**: сверка о возврате покупателю закрывала чужую ногу. Формально
   * красная линия №8 соблюдалась, по существу сверка была отнесена не туда.
   */
  it('не начинает возврат, пока ответ по расчёту не выяснен сверкой', async () => {
    const deal = 'deal-refund-in-flight';
    const tranche = 'tranche-refund-in-flight';
    const path = await toPayingOut({ dealId: deal, trancheId: tranche });
    let world = path.world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'payout_result', outcome: 'unknown' },
      SILENT,
    ).world;
    expect(trancheOf(world, tranche).payouts.at(-1)?.status).toBe('unknown');

    // Транш вытаскивают из `paying_out` заморозкой — другого выхода мимо
    // ответа банка у него нет.
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'compliance_hold', reason: 'compliance_review', frozenBy: 'operator-9' },
      PLAIN,
    ).world;
    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'unfreeze', userIds: ['operator-1', 'operator-2', 'operator-3'], resume: 'release_blocked' },
      PLAIN,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('release_blocked');

    world = applyTrancheEvent(
      world,
      tranche,
      { type: 'refund_requested', reason: 'buyer.requested' },
      PLAIN,
    ).world;
    expect(trancheStatusOf(world, tranche)).toBe('refund_pending');

    // --- Возврат не начинается: поручение в полёте уже есть ---
    const refused = rejectTrancheEvent(world, tranche, { type: 'refund_initiated' });
    expect(refused.code).toBe('domain.guard.failed');
    expect([...refused.failedGuards]).toEqual(['g_no_active_payout']);
    expect(trancheStatusOf(world, tranche)).toBe('refund_pending');

    // Второго поручения не появилось, деньги не двинулись ни на тетри.
    const file = clientLockedAccount(path.buyerKey, deal, tranche);
    expect(trancheOf(world, tranche).payouts).toHaveLength(1);
    expect(accountBalance(world.journal, file, GEL).minor).toBe(20_000_000n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
    expect(invariantViolations(world)).toEqual([]);
  });
});
