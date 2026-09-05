import { describe, expect, it } from 'vitest';
import { accountId, actorRef, personId } from '@sdelka/auth';
import { escalationLevel, prioritize } from '@sdelka/compliance';
import { type Instant, isTerminalWithdrawalStatus } from '@sdelka/domain';
import { money } from '@sdelka/money';
import {
  type WithdrawalStepOptions,
  type WithdrawalWorld,
  PROVISIONAL_WITHDRAWAL_CLOCK_VALUE,
  advance,
  tickWithdrawals,
  withWithdrawals,
  withdrawalClockInEffect,
  withdrawalClockSeries,
  withdrawalStatusOf,
} from '@sdelka/app';
import {
  appendSettingsVersion,
  settingsReasonKey,
  settingsVersion,
  settingsVersionId,
} from '@sdelka/settings';
import { STAFF } from './support/actors';
import {
  applyWithdrawalEvent,
  approveWithdrawal,
  receiveExternalPayment,
  requestWithdrawal,
} from './support/acting';
import {
  BANK_RESPONSE_SOURCE,
  GEL,
  POLICY,
  POLICY_VERSION,
  STATEMENT_SOURCE,
} from './support/fixtures';
import { toCollected } from './support/paths';

/**
 * Заявка на вывод, которая стоит, — и очередь, в которой её видно.
 *
 * ## Что этот файл закрывает
 *
 * `DECISIONS-REVIEW.md` §H4: «у машины вывода нет ни дедлайнов, ни эскалации по
 * возрасту — заявка может стоять сколько угодно, и никто об этом не узнает». У
 * транша ровно это невозможно двумя способами сразу: нетерминальное состояние
 * без дедлайна не собирается (тип) и не сохраняется (проверка базы), а возраст
 * поднимает дежурного. У вывода не было ни одного из трёх.
 *
 * Здесь проверяется то, чего не проверить ни в домене, ни в базе по
 * отдельности: **заявка, простоявшая дольше норматива, оказывается в той же
 * очереди разбора, что задачи комплаенса, и ровно один раз**.
 *
 * ## Чего здесь нет и не должно быть
 *
 * Ни одного перехода, порождённого временем. Тик заявку не двигает: у машины
 * вывода нет ни одного события, порождаемого сроком. Это красная линия №8 —
 * «неизвестно» у выплаты легально, и повтор из него запрещён без сверки, —
 * и последний сценарий файла её сторожит.
 */

const STEP: WithdrawalStepOptions = {
  policy: POLICY_VERSION,
  evidence: [STATEMENT_SOURCE],
};
const SETTLED: WithdrawalStepOptions = { ...STEP, response: BANK_RESPONSE_SOURCE };
const TICK = { policy: POLICY_VERSION } as const;

const SPARE = money(GEL, 10_000_000n);
const PART = money(GEL, 5_000_000n);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Норматив приходит **из журнала версий настроек**, а не константой из кода.
 *
 * Значение первой версии — временное умолчание
 * (`PROVISIONAL_WITHDRAWAL_CLOCK_VALUE`, `DECISIONS-REVIEW.md` §H4
 * **[открыто]**): его назначает владелец, и сценарий не вправе придумать своё.
 * Смысл этого шага в том, что величина **уже сегодня** живёт версией с автором,
 * основанием и моментом вступления в силу, а не полем конфигурации.
 */
function clockFromSettings(now: Instant) {
  const seeded = appendSettingsVersion(
    withdrawalClockSeries(),
    settingsVersion({
      versionId: settingsVersionId('withdrawal_clock/2026-09-01.1'),
      value: PROVISIONAL_WITHDRAWAL_CLOCK_VALUE,
      introducedBy: actorRef(accountId('acc-principal'), personId('person-principal')),
      introducedByRole: 'principal',
      reasonKey: settingsReasonKey('settings.reason.provisional_default'),
      recordedAt: (now - YEAR_MS) as Instant,
      effectiveFrom: (now - YEAR_MS) as Instant,
      supersedes: null,
    }),
  );
  if (!seeded.ok) throw new Error(`журнал версий не сложился: ${seeded.error}`);
  const resolved = withdrawalClockInEffect(seeded.value, now);
  if (!resolved.ok) throw new Error(`действующей версии часов нет: ${resolved.error}`);
  return resolved.value.applied.value;
}

async function standingWithdrawal(suffix: string): Promise<WithdrawalWorld> {
  const collected = await toCollected({ dealId: `deal-${suffix}`, trancheId: `tranche-${suffix}` });
  const world = receiveExternalPayment(collected.world, collected.buyerKey, SPARE);
  const scene = withWithdrawals(world, clockFromSettings(world.now));
  return requestWithdrawal(scene, {
    withdrawalId: suffix,
    owner: collected.buyerKey,
    amount: PART,
  });
}

describe('заявка на вывод, которая стоит', () => {
  it('свежая заявка в очередь не попадает, простоявшая — попадает один раз', async () => {
    let scene = await standingWithdrawal('wds-1');

    // Норматив ещё не вышел: очередь пуста, и это ответ, а не молчание.
    scene = { ...scene, world: advance(scene.world, DAY_MS - 1) };
    const early = tickWithdrawals(scene, TICK);
    expect(early.stalled).toEqual([]);
    expect(early.scene.world.tasks).toEqual([]);

    // Норматив вышел — заявка поднята дежурному.
    scene = { ...scene, world: advance(early.scene.world, 1) };
    const first = tickWithdrawals(scene, TICK);
    expect(first.stalled.map((item) => item.withdrawalId)).toEqual(['wds-1']);
    expect(first.stalled[0]?.status).toBe('requested');
    expect(first.stalled[0]?.ageMs).toBe(DAY_MS);

    const task = first.scene.world.tasks[0];
    expect(first.scene.world.tasks).toHaveLength(1);
    expect(task?.kind).toBe('withdrawal_stalled');
    // Предмет задачи назван: у заявки нет сделки, и выдумывать её не из чего.
    expect(task?.withdrawalId).toBe('wds-1');
    expect(task?.dealId).toBeNull();
    expect(task?.trancheId).toBeNull();
    // Возраст задачи — возраст простоя, а не момент, когда часы до неё дошли.
    expect(task?.enteredAt).toBe(first.scene.world.now - DAY_MS);
    // Срок операции у задачи есть, и он не участвует в приоритете.
    expect(task?.deadlineAt).not.toBeNull();

    // Часы ходят каждые пятнадцать минут. Сколько бы раз они ни прошли по той же
    // стоящей заявке, задача остаётся одна: иначе к утру дежурный получил бы
    // сотню строк об одном и том же выводе и перестал бы читать очередь.
    let repeated = first.scene;
    for (let step = 0; step < 10; step += 1) {
      repeated = { ...repeated, world: advance(repeated.world, 15 * 60 * 1000) };
      const again = tickWithdrawals(repeated, TICK);
      expect(again.stalled).toEqual([]);
      repeated = again.scene;
    }
    expect(repeated.world.tasks).toHaveLength(1);
    expect(withdrawalStatusOf(repeated, 'wds-1')).toBe('requested');
  });

  it('задача о простое встаёт в ту же очередь и ранжируется её правилами', async () => {
    let scene = await standingWithdrawal('wds-2');
    scene = { ...scene, world: advance(scene.world, DAY_MS) };
    const ticked = tickWithdrawals(scene, TICK);
    const tasks = ticked.scene.world.tasks;
    expect(tasks).toHaveLength(1);

    // Второй очереди «для выводов» нет: задача ранжируется тем же
    // `prioritize`, что задачи комплаенса, и эскалация по возрасту достаётся ей
    // тем же способом.
    const ranked = prioritize(tasks, POLICY.queue, ticked.scene.world.now);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.task.kind).toBe('withdrawal_stalled');
    expect(ranked[0]?.escalation).toBeGreaterThan(0);
    const only = ranked[0]?.task;
    if (only === undefined) throw new Error('задача о простое не нашлась');
    expect(escalationLevel(only, ticked.scene.world.now, POLICY.queue)).toBeGreaterThan(0);
  });

  it('новый простой — новая задача, а тот же простой второй задачи не даёт', async () => {
    let scene = await standingWithdrawal('wds-3');
    scene = { ...scene, world: advance(scene.world, DAY_MS) };
    const stalledRequested = tickWithdrawals(scene, TICK);
    expect(stalledRequested.scene.world.tasks).toHaveLength(1);

    // Заявка сдвинулась: собраны подписи, состояние другое — простой начался
    // заново, и часы дежурного пошли с нуля.
    let moved = stalledRequested.scene;
    moved = approveWithdrawal(moved, 'wds-3', STAFF.controller);
    moved = approveWithdrawal(moved, 'wds-3', STAFF.head);
    moved = applyWithdrawalEvent(moved, 'wds-3', { type: 'withdrawal_approved' }, STEP);
    expect(withdrawalStatusOf(moved, 'wds-3')).toBe('approved');

    const fresh = tickWithdrawals(moved, TICK);
    expect(fresh.stalled).toEqual([]);

    // Норматив `approved` короче: четыре часа на отправку поручения.
    let waiting = { ...fresh.scene, world: advance(fresh.scene.world, 4 * HOUR_MS) };
    const second = tickWithdrawals(waiting, TICK);
    expect(second.stalled.map((item) => item.status)).toEqual(['approved']);
    expect(second.scene.world.tasks).toHaveLength(2);
    expect(new Set(second.scene.world.tasks.map((item) => item.taskId)).size).toBe(2);

    // И снова: тот же простой второй задачи не даёт.
    waiting = { ...second.scene, world: advance(second.scene.world, DAY_MS) };
    expect(tickWithdrawals(waiting, TICK).scene.world.tasks).toHaveLength(2);
  });

  it('из «неизвестно» повтора нет ни при каком возрасте', async () => {
    // Красная линия №8. Проверяется не отсутствие кнопки, а отсутствие дороги:
    // сколько бы времени ни прошло, часы не порождают ни события, ни поручения,
    // и заявка остаётся в `paying_out` до сверки — то есть до внешнего факта.
    let scene = await standingWithdrawal('wds-4');
    scene = approveWithdrawal(scene, 'wds-4', STAFF.controller);
    scene = approveWithdrawal(scene, 'wds-4', STAFF.head);
    scene = applyWithdrawalEvent(scene, 'wds-4', { type: 'withdrawal_approved' }, STEP);
    scene = applyWithdrawalEvent(scene, 'wds-4', { type: 'withdrawal_dispatched' }, STEP);
    scene = applyWithdrawalEvent(
      scene,
      'wds-4',
      { type: 'payout_result', outcome: 'unknown' },
      STEP,
    );
    expect(withdrawalStatusOf(scene, 'wds-4')).toBe('paying_out');

    const recordsBefore = scene.world.chain.records.length;
    const nominalBefore = scene.world.journal.entries.length;

    let aged = scene;
    for (const span of [2 * DAY_MS, 30 * DAY_MS, YEAR_MS]) {
      aged = { ...aged, world: advance(aged.world, span) };
      const ticked = tickWithdrawals(aged, TICK);
      aged = ticked.scene;
      // Статус не сдвинулся ни на одном возрасте: автоматического повтора нет.
      expect(withdrawalStatusOf(aged, 'wds-4')).toBe('paying_out');
      expect(isTerminalWithdrawalStatus('paying_out')).toBe(false);
    }
    // Ни одной новой записи журнала аудита и ни одной новой проводки: тик
    // ничего не поручал и ничего не двигал.
    expect(aged.world.chain.records.length).toBe(recordsBefore);
    expect(aged.world.journal.entries.length).toBe(nominalBefore);
    // Задача о простое при этом заведена — и ровно одна на весь простой.
    expect(aged.world.tasks).toHaveLength(1);
    expect(aged.world.tasks[0]?.kind).toBe('withdrawal_stalled');

    // Выйти отсюда можно только сверкой — внешним фактом и человеком.
    const resolved = applyWithdrawalEvent(
      aged,
      'wds-4',
      { type: 'reconciliation_resolved', outcome: 'settled' },
      SETTLED,
    );
    expect(withdrawalStatusOf(resolved, 'wds-4')).toBe('paid_out');
    // Закрытая заявка часов не носит и в очередь больше не попадает никогда.
    const closed = tickWithdrawals(
      { ...resolved, world: advance(resolved.world, YEAR_MS) },
      TICK,
    );
    expect(closed.stalled).toEqual([]);
    expect(closed.scene.world.tasks).toHaveLength(1);
  });
});
