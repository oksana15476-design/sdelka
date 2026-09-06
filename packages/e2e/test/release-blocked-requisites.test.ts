import { describe, expect, it } from 'vitest';
import {
  APPROVER_ROLE,
  OPERATOR_ROLE,
  accountFingerprint,
  actor,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  authorize,
  openBeneficiaryChange,
  prioritize,
  toBeneficiaryConfirmation,
} from '@sdelka/compliance';
import { instant } from '@sdelka/domain';
import {
  accountBalance,
  bankNominal,
  checkLedgerInvariants,
  clientFreeAccount,
  clientLockedAccount,
  coverage,
} from '@sdelka/ledger';
import {
  advance,
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import { STAFF } from './support/actors';
import { applyTrancheEvent, approve, attachObservation, patchFacts } from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  CADASTRAL_CODE,
  DAY_MS,
  GEL,
  POLICY,
  POLICY_VERSION,
  SELLER,
  extractOf,
  fp,
  registryWithEncumbrance,
  registryWithTransfer,
} from './support/fixtures';
import { toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });
const HOUR_MS = 60 * 60 * 1000;

/**
 * Сценарий 15 — выход из разбора в выплату: путь, который документ обещал, а
 * автомат не давал пройти.
 *
 * `STATE-MACHINES.md` §1.4 называет `release_blocked --approval_added-->
 * release_pending` штатным выходом «расхождение снято», а §1.5 предписывал
 * снимать блокировку реквизитов при уходе из `reserved` во всё, кроме выплаты и
 * заморозки. Обе нормы были реализованы буквально, и вместе они закрывали
 * выплату навсегда: на ребре `release_pending --release_authorized-->
 * paying_out` стоит `g_beneficiary_locked`, а запереть реквизиты обратно нечем —
 * единственное намерение `lock_beneficiary` живёт на входе в `reserved`, а
 * вернуться туда из разбора нельзя (часы `release_blocked` молчат,
 * `DUE_TRANCHE_EVENTS.release_blocked = null`).
 *
 * Все три сквозных сценария, которым этот путь был нужен
 * (`beneficiary-verification`, `evidence-package`, `registration-failed`),
 * восстанавливали блокировку вызовом `patchFacts` — тем самым чёрным ходом,
 * который `ACTORS.md` §5.1 п.4 требует убрать. То есть довести транш после
 * расхождения до банка можно было **только** им.
 *
 * Здесь путь пройден целиком и без единого чёрного хода.
 */
describe('выход из разбора: реквизиты и выплата', () => {
  it('доводит транш от расхождения до выплаты — блокировка реквизитов держится весь разбор', async () => {
    const DEAL = 'deal-blocked-requisites';
    const TRANCHE = 'tranche-blocked-requisites';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = reserved.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('reserved');
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);
    expect(trancheOf(world, TRANCHE).beneficiary.status).toBe('verified');

    // --- Расхождение: в выписке необъявленное обременение ---
    world = attachObservation(
      world,
      TRANCHE,
      extractOf(registryWithEncumbrance(), CADASTRAL_CODE),
      'evidence-encumbered',
      POLICY,
    );
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'registry.encumbrance' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    // Разбор — работа оператора, а не авария: задача в очереди, обе стороны
    // уведомлены (`AUTOMATION-COST.md` И6 считает такой разбор штатным).
    const ranked = prioritize(world.tasks, POLICY.queue, world.now);
    expect(ranked[0]?.task.trancheId).toBe(TRANCHE);

    // **Главное утверждение сценария.** Реквизиты остались заперты: разбор — не
    // уход из резерва, а его приостановка, ровно как заморозка (§1.5). Деньги
    // при этом тоже никуда не двинулись — они в файле транша.
    expect(trancheOf(world, TRANCHE).beneficiary.locked).toBe(true);
    expect(
      accountBalance(world.journal, clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE), GEL).minor,
    ).toBe(20_000_000n);

    // --- Разбор закончен: обременение снято, выписка перевыпущена ---
    world = attachObservation(
      world,
      TRANCHE,
      extractOf(registryWithTransfer(), CADASTRAL_CODE),
      'evidence-clean',
      POLICY,
    );
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'approval_added', userId: 'approver-1' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    // --- И выплата уходит. Прежде здесь стоял вечный отказ ---
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    expect(trancheOf(world, TRANCHE).payouts).toHaveLength(1);

    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'payout_result', outcome: 'settled' },
      SETTLED,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');
    // Деньги у получателя, файл транша пуст, журнал сходится.
    expect(accountBalance(world.journal, clientFreeAccount(reserved.sellerKey), GEL).minor).toBe(
      19_700_000n,
    );
    expect(
      accountBalance(world.journal, clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE), GEL).minor,
    ).toBe(0n);
    expect(checkLedgerInvariants(world.journal)).toEqual([]);
    expect(coverage(world.journal).find((item) => item.currency === GEL)?.difference.minor).toBe(0n);
  });

  it('не выпускает выплату, если к моменту авторизации реквизиты не заперты', async () => {
    const DEAL = 'deal-blocked-unlocked';
    const TRANCHE = 'tranche-blocked-unlocked';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = reserved.world;
    world = attachObservation(
      world,
      TRANCHE,
      extractOf(registryWithTransfer(), CADASTRAL_CODE),
      'evidence-clean',
      POLICY,
    );
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'registry.encumbrance' },
      OPTIONS,
    ).world;
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'approval_added', userId: 'approver-1' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    // Реквизиты оказались незапертыми. Внутри продукта такого пути больше нет —
    // именно поэтому состояние здесь ставится чёрным ходом, а не сценарием: это
    // **прежнее** поведение автомата, воспроизведённое нарочно. Всё остальное на
    // пути готово: выписка чистая, пакет собран, две подписи набраны, деньги в
    // файле транша.
    const beneficiary = trancheOf(world, TRANCHE).beneficiary;
    world = patchFacts(world, TRANCHE, {
      beneficiary: toBeneficiaryConfirmation({ ...beneficiary, locked: false }),
    });

    const refused = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect(refused.code).toBe('domain.guard.failed');
    expect([...refused.failedGuards]).toEqual(['g_beneficiary_locked']);
    // Транш остаётся в `release_pending`, поручение не выпущено, деньги стоят.
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');
    expect(trancheOf(world, TRANCHE).payouts).toEqual([]);
    expect(accountBalance(world.journal, clientFreeAccount(reserved.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);
  });

  it('не даёт разбору стать дешёвым способом сменить реквизиты профинансированной сделки', async () => {
    const DEAL = 'deal-blocked-swap';
    const TRANCHE = 'tranche-blocked-swap';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    let world = reserved.world;
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'mismatch_detected', field: 'registry.encumbrance' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');

    const locked = trancheOf(world, TRANCHE).beneficiary;
    expect(locked.locked).toBe(true);

    const writer = authorize(actor('operator-1', OPERATOR_ROLE), 'write_beneficiary');
    const proposed = {
      account: accountFingerprint(fp(915)),
      holderNames: SELLER.names,
      holderDocument: SELLER.document,
      ownershipEvidence: null,
    };
    // Расчёт не раньше чем через пять суток: заявка вне запретного окна 72 часа,
    // иначе она отвергается автоматом и разговор кончается раньше времени.
    const releaseAt = instant(world.now + 5 * DAY_MS);

    // --- Реквизиты заперты: смена стоит полной процедуры ---
    const opened = openBeneficiaryChange(
      locked,
      { requestId: 'swap-in-review', proposed, releaseAt, dealFunded: true },
      writer,
      POLICY,
      world.now,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('unreachable');
    expect(opened.value.effects.map((effect) => effect.type)).toEqual([
      'require_reverification',
      'notify_all_parties_all_channels',
      'require_second_approval',
    ]);

    // Ровно то, что стоило бы снятие блокировки в разборе: у незапертых
    // реквизитов та же заявка требует одной лишь переверификации — ни
    // уведомления сторонам, ни второго утверждения, ни охлаждения (`CORE.md`
    // Ф15, инварианты 16–18).
    const asUnlocked = openBeneficiaryChange(
      { ...locked, locked: false },
      { requestId: 'swap-if-unlocked', proposed, releaseAt, dealFunded: true },
      writer,
      POLICY,
      world.now,
    );
    expect(asUnlocked.ok).toBe(true);
    if (!asUnlocked.ok) throw new Error('unreachable');
    expect(asUnlocked.value.effects.map((effect) => effect.type)).toEqual([
      'require_reverification',
    ]);

    // --- Полная процедура пройдена, реквизиты сменились ---
    let request = opened.value.request;
    for (const event of [
      { type: 'reverification_passed' as const },
      { type: 'parties_notified' as const },
      { type: 'approval_added' as const, userId: 'approver-1' },
    ]) {
      const moved = advanceBeneficiaryChange(request, event, world.now);
      expect(moved.ok).toBe(true);
      if (!moved.ok) throw new Error('unreachable');
      request = moved.value;
    }
    // Охлаждение 24 часа — настоящее: до его истечения применение отвергается.
    const tooEarly = applyBeneficiaryChange(
      locked,
      request,
      { releaseAt, dealFunded: true, locked: locked.locked },
      authorize(actor('approver-2', APPROVER_ROLE), 'approve_beneficiary_change'),
      POLICY,
      world.now,
    );
    expect(tooEarly.ok).toBe(false);

    world = advance(world, 25 * HOUR_MS);
    const applied = applyBeneficiaryChange(
      locked,
      request,
      { releaseAt, dealFunded: true, locked: locked.locked },
      authorize(actor('approver-2', APPROVER_ROLE), 'approve_beneficiary_change'),
      POLICY,
      world.now,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('unreachable');
    // Новые реквизиты не наследуют доказательство владения: оно относилось к
    // другому счёту.
    expect(applied.value.status).toBe('name_consistent');

    // ⚠ Единственный чёрный ход в этом сценарии, и он не про блокировку:
    // продуктового шага, который доносит решение комплаенса о реквизитах до
    // фактов транша, в `packages/app` сегодня нет вовсе. Отмечено в отчёте.
    world = patchFacts(world, TRANCHE, { beneficiary: toBeneficiaryConfirmation(applied.value) });

    // --- И выплата на новые реквизиты не проходит ---
    world = attachObservation(
      world,
      TRANCHE,
      extractOf(registryWithTransfer(), CADASTRAL_CODE),
      'evidence-clean',
      POLICY,
    );
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    world = applyTrancheEvent(
      world,
      TRANCHE,
      { type: 'approval_added', userId: 'approver-1' },
      OPTIONS,
    ).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    const refused = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    // Первые два отказа — о реквизитах, и оба по делу: владение новым счётом не
    // доказано, а отметка изменения попала внутрь запретных 72 часов перед
    // расчётом. Третий — о свежести выписки: часы сценария ушли на 25 часов
    // вперёд (охлаждение), а предельный возраст наблюдения — сутки
    // (`ORACLE.md` §6.3). Перевыпуск выписки его не снимает: фикстура реестра
    // датирована NOW. Список оставлен полным нарочно — сокращать его до
    // «интересных» guard'ов значит перестать замечать такие изменения.
    expect([...refused.failedGuards].sort()).toEqual([
      'g_beneficiary_locked',
      'g_beneficiary_verified',
      'g_observation_sufficient',
    ]);
    expect(trancheOf(world, TRANCHE).payouts).toEqual([]);
    expect(accountBalance(world.journal, clientFreeAccount(reserved.sellerKey), GEL).minor).toBe(0n);
  });
});
