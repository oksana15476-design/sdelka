import { describe, expect, it } from 'vitest';
import { toBeneficiaryLock } from '@sdelka/compliance';
import { accountBalance, bankNominal, clientFreeAccount, clientLockedAccount } from '@sdelka/ledger';
import { STAFF } from './support/actors';
import {
  rejectTrancheEvent,
  trancheOf,
  trancheOptions,
  trancheStatusOf,
} from '@sdelka/app';
import {
  applyTrancheEvent,
  approve,
  attachObservation,
  patchFacts,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  CADASTRAL_CODE,
  GEL,
  POLICY,
  POLICY_VERSION,
  extractOf,
  registryWithEncumbrance,
  registryWithTransfer,
} from './support/fixtures';
import { toPayingOut, toReserved } from './support/paths';

const OPTIONS = trancheOptions(POLICY_VERSION);
const SETTLED = trancheOptions(POLICY_VERSION, { payoutResponse: BANK_RESPONSE_SOURCE });

/**
 * Сценарий 12 — пакет доказательств: выписка и ссылка на него.
 *
 * Два guard'а, которые в жизни стоят на одном и том же столе оператора и
 * поэтому легко сливаются в голове в одно правило «документы в порядке»:
 *
 * - `g_fields_match` — содержимое платной выписки: сошлись ли **все пять**
 *   полей. Проверяются поимённо, а не счётчиком совпадений, ровно потому, что
 *   четыре из пяти — это обычно и есть настоящая беда: переход права
 *   состоялся, а вещь обременена;
 * - `g_evidence_present` — существует ли вообще ссылка на пакет, под которым
 *   принято решение. Красная линия №5: выплата без неё невозможна.
 *
 * Оба продублированы на каждом входе пути выплаты, и здесь проверяется именно
 * это: guard, стоящий на одной двери, состояние не защищает.
 */
describe('пакет доказательств', () => {
  it('не выпускает выплату при обременении в выписке — ни прямой дверью, ни через блокировку', async () => {
    const DEAL = 'deal-encumbered';
    const TRANCHE = 'tranche-encumbered';

    const reserved = await toReserved({ dealId: DEAL, trancheId: TRANCHE });
    // Выписка платная, приложена, переход права на покупателя состоялся —
    // и в ней обременение, которого стороны не объявляли.
    const encumbered = extractOf(registryWithEncumbrance(), CADASTRAL_CODE);
    // Собственник установлен по номеру документа, а не по флагу порта: вердикт
    // считает `reconcileOwner` внутри приложения (`CORE.md` Ф7).
    expect(encumbered.ownerDocumentNumber).toBe('matched');
    expect(encumbered.fields.noUnexpectedEncumbrances).toBe(false);

    let world = attachObservation(reserved.world, TRANCHE, encumbered, 'evidence-encumbered', POLICY);
    expect(trancheOf(world, TRANCHE).facts.evidenceBundleId).toBe('evidence-encumbered');

    // --- Первая дверь: условие не устанавливается ---
    const refused = rejectTrancheEvent(world, TRANCHE, {
      type: 'condition_established',
      evidenceBundleId: 'evidence-encumbered',
      conditionType: 'registration_transfer',
    });
    expect([...refused.failedGuards]).toEqual(['g_fields_match']);

    // --- Вторая дверь: обход через блокировку ---
    // Оператор уводит транш в разбор и выпускает обратно своим утверждением.
    // Именно этот путь §1.4 называет причиной, по которой guard'ы доказательств
    // продублированы: guard, стоящий на одном входе, не защищает состояние.
    world = applyTrancheEvent(world, TRANCHE, { type: 'mismatch_detected', field: 'registry.encumbrance' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_blocked');
    world = applyTrancheEvent(world, TRANCHE, { type: 'approval_added', userId: 'approver-1' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('release_pending');

    // Уход из резерва снял блокировку реквизитов — правило соседнее и здесь ни
    // при чём; реквизиты запираются обратно, чтобы отказ остался ровно один и
    // именно про выписку. Утверждения набираются по той же причине.
    const beneficiary = trancheOf(world, TRANCHE).beneficiary;
    world = patchFacts(world, TRANCHE, {
      beneficiary: toBeneficiaryLock({ ...beneficiary, locked: true }),
    });
    world = approve(world, TRANCHE, STAFF.controller);
    world = approve(world, TRANCHE, STAFF.head);
    const refusedAgain = rejectTrancheEvent(world, TRANCHE, { type: 'release_authorized' });
    expect([...refusedAgain.failedGuards]).toEqual(['g_fields_match']);

    // Ни поручения, ни движения денег: средства стоят в файле транша.
    expect(trancheOf(world, TRANCHE).payouts).toEqual([]);
    expect(accountBalance(world.journal, clientLockedAccount(reserved.buyerKey, DEAL, TRANCHE), GEL).minor).toBe(
      20_000_000n,
    );
    expect(accountBalance(world.journal, clientFreeAccount(reserved.sellerKey), GEL).minor).toBe(0n);

    // --- Обременение снято, выписка перевыпущена: та же дверь открывается ---
    world = attachObservation(
      world,
      TRANCHE,
      extractOf(registryWithTransfer(), CADASTRAL_CODE),
      'evidence-clean',
      POLICY,
    );
    world = applyTrancheEvent(world, TRANCHE, { type: 'release_authorized' }, OPTIONS).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
  });

  it('не записывает расчёт, если к ответу банка ссылка на пакет доказательств пропала', async () => {
    const DEAL = 'deal-evidence-lost';
    const TRANCHE = 'tranche-evidence-lost';

    // Транш дошёл до банка со всеми доказательствами: поручение ушло, ссылка на
    // пакет в нём есть.
    const path = await toPayingOut({ dealId: DEAL, trancheId: TRANCHE });
    let world = path.world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    const entriesBefore = world.journal.entries.length;

    // ⚠ Факты приходят снаружи на каждый вызов. Между отправкой поручения и
    // ответом банка проходит время, и пакет доказательств за это время может
    // перестать быть предъявимым: выписка отозвана реестром, хранилище
    // документов потеряло ссылку, решение отменено. Домен этого не знает — он
    // видит только факты, которые ему принесли.
    world = patchFacts(world, TRANCHE, { evidenceBundleId: null });

    // --- Банк подтвердил, но записать расчёт нечем ---
    // Именно на этом ребре пишется запись расчёта, и именно она несёт
    // `evidenceRef` (красная линия №5). Расчёт со ссылкой в никуда — это
    // выплата без основания, поэтому переход отвергается.
    const refused = rejectTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' });
    expect([...refused.failedGuards]).toEqual(['g_evidence_present']);
    // Сверка тем же ребром и с тем же результатом: второй вход в `paid_out`
    // защищён так же, как первый.
    const refusedReconciliation = rejectTrancheEvent(world, TRANCHE, {
      type: 'reconciliation_resolved',
      outcome: 'settled',
    });
    expect([...refusedReconciliation.failedGuards]).toEqual(['g_evidence_present']);

    // Транш остаётся в `paying_out` — состоянии, из которого выход идёт через
    // сверку человеком. Это и есть безопасная сторона: деньги уже ушли из
    // банка, и «не записали расчёт» хуже, чем «остановились и разбираем».
    expect(trancheStatusOf(world, TRANCHE)).toBe('paying_out');
    expect(world.journal.entries).toHaveLength(entriesBefore);
    expect(accountBalance(world.journal, clientFreeAccount(path.sellerKey), GEL).minor).toBe(0n);
    expect(accountBalance(world.journal, bankNominal(GEL), GEL).minor).toBe(20_000_000n);

    // --- Ссылка восстановлена: тот же ответ банка закрывает транш ---
    world = patchFacts(world, TRANCHE, { evidenceBundleId: `evidence-${TRANCHE}` });
    world = applyTrancheEvent(world, TRANCHE, { type: 'payout_result', outcome: 'settled' }, SETTLED).world;
    expect(trancheStatusOf(world, TRANCHE)).toBe('paid_out');
    const settlement = world.journal.entries.find((entry) => entry.memoKey === 'ledger.entry.tranche_settled');
    // Ссылка на пакет осталась в журнале, а не только в решении оператора.
    expect(settlement?.settles?.evidenceRef).toBe(`evidence-${TRANCHE}`);
  });
});
