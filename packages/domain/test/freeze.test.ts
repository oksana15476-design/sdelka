import { describe, expect, it } from 'vitest';
import {
  type Instant,
  type TrancheEvent,
  type TrancheState,
  type ThawedTrancheStatus,
  DAY,
  DEFAULT_DEADLINE_POLICY,
  DEFAULT_ESCALATION_POLICY,
  DISPATCHED_TRANCHE_STATUSES,
  FREEZABLE_TRANCHE_STATUSES,
  HOUR,
  RESUMABLE_TRANCHE_STATUSES,
  RejectionCode,
  TRANCHE_TRANSITIONS,
  duration,
  instant,
  isEscalated,
  remainingUntil,
  trancheStateAge,
} from '../src/index';
import { NOW, context } from './support/facts';
import { accept, frozenStateAt, reject, stateAt } from './support/drive';

const at = (offset: number): Instant => instant(NOW + offset);

const hold: TrancheEvent = {
  type: 'compliance_hold',
  reason: 'sanctions',
  frozenBy: 'compliance-1',
};

function deadlineOf(state: TrancheState): number {
  if (!('deadline' in state)) {
    throw new Error('state has no deadline');
  }
  return state.deadline.at;
}

/**
 * E9-9 и E9-10 — CORE.md Ф17, ROADMAP.md И9.2.
 *
 * Два инварианта ядра противоречат друг другу ровно в одном месте: красная
 * линия №7 говорит «состояние по умолчанию при бездействии — возврат», Ф17
 * говорит «замороженное обязательство исполнять запрещено». Приоритет записан
 * заранее и в пользу заморозки.
 */
describe('заморозка имеет приоритет над возвратом по умолчанию', () => {
  it('refuses deadline_reached on a frozen tranche instead of refunding it', () => {
    const frozen = accept(stateAt('collecting'), hold, context()).state;
    expect(frozen.status).toBe('frozen');

    // Дедлайн давно прошёл, планировщик пришёл — и получил отказ, а не возврат.
    const error = reject(frozen, { type: 'deadline_reached' }, context({}, at(30 * DAY)));
    expect(error.code).toBe(RejectionCode.transitionNotAllowed);
  });

  it('has no automatic edge out of frozen at all', () => {
    // Приоритет реализован отсутствием строк в таблице, а не веткой в коде:
    // ветку обходит новый вызов, таблицу — нет (§2.2, §4).
    const automatic = TRANCHE_TRANSITIONS.filter(
      (item) =>
        item.from === 'frozen' &&
        ['deadline_reached', 'payout_result', 'refund_initiated', 'reconciliation_resolved'].includes(
          item.event,
        ),
    );
    expect(automatic).toEqual([]);
  });

  it('refuses the payout leg events on a frozen tranche', () => {
    const frozen = frozenStateAt('paying_out', DAY);
    for (const event of [
      { type: 'payout_result', outcome: 'settled' },
      { type: 'refund_initiated' },
      { type: 'release_authorized' },
    ] as const) {
      expect(reject(frozen, event, context()).code).toBe(RejectionCode.transitionNotAllowed);
    }
  });

  it('freezes from every state that holds money, and never from pending', () => {
    expect([...FREEZABLE_TRANCHE_STATUSES]).not.toContain('pending');
    for (const status of FREEZABLE_TRANCHE_STATUSES) {
      expect(accept(stateAt(status), hold, context()).state.status).toBe('frozen');
      expect(
        accept(stateAt(status), { type: 'dispute_raised', frozenBy: 'party-1' }, context()).state
          .status,
      ).toBe('frozen');
    }
    // В `pending` денег нет — замораживать нечего, а вход обратно означал бы,
    // что транш, у которого деньги уже были, снова «создан, денег нет».
    expect(reject(stateAt('pending'), hold, context()).code).toBe(
      RejectionCode.transitionNotAllowed,
    );
  });
});

describe('дедлайн приостанавливается, а не отменяется и не отодвигается', () => {
  it('resumes with exactly the unspent part, however long the freeze lasted', () => {
    // Транш заморожен за два часа до отсечки...
    const twoHoursBefore = at(DEFAULT_DEADLINE_POLICY.collecting - 2 * HOUR);
    const frozen = accept(stateAt('collecting'), hold, context({}, twoHoursBefore)).state;
    expect('deadline' in frozen).toBe(false);
    expect('remaining' in frozen && frozen.remaining).toBe(2 * HOUR);

    // ...и разморожен через три недели.
    const thawAt = at(21 * DAY);
    const thawed = accept(
      frozen,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
      context({}, thawAt),
    ).state;
    expect(thawed.status).toBe('collecting');
    // Ровно два часа: заморозка не приблизила отсечку и не отодвинула её.
    expect(deadlineOf(thawed)).toBe(thawAt + 2 * HOUR);
  });

  it('emits suspend_deadline on freeze and set_deadline on thaw, and nothing else', () => {
    const freeze = accept(stateAt('collected'), hold, context());
    expect(freeze.intents).toEqual([
      { type: 'suspend_deadline', remaining: DEFAULT_DEADLINE_POLICY.collected },
    ]);

    const thaw = accept(
      freeze.state,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
      context({}, at(HOUR)),
    );
    // Разморозка не переигрывает вход: ни `lock_beneficiary`, ни уведомления,
    // ни тем более повторного поручения на выплату.
    expect(thaw.intents.map((intent) => intent.type)).toEqual(['set_deadline']);
  });

  it('does not re-issue the outbound payout when thawing a tranche frozen mid-payout', () => {
    const frozen = frozenStateAt('paying_out', duration(HOUR));
    const thaw = accept(
      frozen,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'release_blocked' },
      context({}, at(DAY)),
    );
    expect(thaw.state.status).toBe('release_blocked');
    expect(thaw.intents.map((intent) => intent.type)).not.toContain('enqueue_outbound_payout');
  });

  it('gives no extra time when the deadline had already passed', () => {
    // Планировщик ходит раз в пятнадцать минут (инвариант 7): есть окно, где
    // дедлайн прошёл, а перехода ещё не было. Заморозка в этом окне не дарит
    // времени — остаток зажимается в минимум, отсечка срабатывает сразу.
    const late = at(DEFAULT_DEADLINE_POLICY.collecting + 10 * HOUR);
    const frozen = accept(stateAt('collecting'), hold, context({}, late)).state;
    expect('remaining' in frozen && frozen.remaining).toBe(1);
    expect(remainingUntil({ at: at(0) }, at(DAY))).toBe(1);
  });

  it('takes a fresh deadline from the policy when the target is a different state', () => {
    // Остаток принадлежит часам того статуса, из которого заморозили. Возврат и
    // разбор человеком — чужие часы, они не наследуют неистёкшую часть.
    const frozen = frozenStateAt('collecting', duration(HOUR));
    const thawAt = at(DAY);
    const refund = accept(
      frozen,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'refund_pending' },
      context({}, thawAt),
    ).state;
    expect(refund.status).toBe('refund_pending');
    expect(deadlineOf(refund)).toBe(thawAt + DEFAULT_DEADLINE_POLICY.refund_pending);
  });
});

describe('возраст замороженного состояния идёт, даже когда дедлайн стоит', () => {
  it('escalates a long freeze by age', () => {
    const frozen = accept(stateAt('reserved'), hold, context()).state;
    expect(trancheStateAge(frozen, at(2 * DAY))).toBe(2 * DAY);
    // §5 требует у `frozen` обязательный срок разбора. Дедлайна у него нет —
    // значит, поднять его дежурному может только возраст.
    expect(isEscalated(frozen, at(2 * DAY), DEFAULT_ESCALATION_POLICY)).toBe(true);
    expect(isEscalated(frozen, at(HOUR), DEFAULT_ESCALATION_POLICY)).toBe(false);
  });

  it('resets the attention clock on thaw while the money clock keeps its remainder', () => {
    const frozen = frozenStateAt('reserved', duration(2 * HOUR), { enteredAt: NOW });
    const thawAt = at(21 * DAY);
    const thawed = accept(
      frozen,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
      context({}, thawAt),
    ).state;
    // Часы денег досчитываются: остаток тот же.
    expect(deadlineOf(thawed)).toBe(thawAt + 2 * HOUR);
    // Часы внимания начинаются заново: иначе транш после трёхнедельной
    // заморозки эскалируется в ту же секунду (§5 — две отметки, две заботы).
    expect(trancheStateAge(thawed, thawAt)).toBe(0);
  });
});

describe('заморозка не сбрасывает периметр реквизитов (CORE.md Ф15)', () => {
  it('keeps the beneficiary lock while the tranche is frozen', () => {
    const freeze = accept(stateAt('reserved'), hold, context());
    // Без этого заморозка стала бы способом снять блокировку реквизитов на
    // время расследования — то есть защита превратилась бы в дыру.
    expect(freeze.intents.map((intent) => intent.type)).not.toContain('unlock_beneficiary');

    // А обычный уход из резерва блокировку по-прежнему снимает.
    const expired = accept(stateAt('reserved'), { type: 'reserve_expired' }, context());
    expect(expired.intents.map((intent) => intent.type)).toContain('unlock_beneficiary');
  });

  it('does not re-lock or re-notify the seller when thawing back into reserved', () => {
    const frozen = frozenStateAt('reserved', duration(HOUR));
    const thaw = accept(
      frozen,
      { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
      context({}, at(HOUR)),
    );
    expect(thaw.state.status).toBe('reserved');
    expect(thaw.intents.map((intent) => intent.type)).not.toContain('lock_beneficiary');
    expect(thaw.intents.map((intent) => intent.type)).not.toContain('notify');
  });
});

describe('разморозку утверждают двое, и не те же самые', () => {
  it('requires two distinct approvers', () => {
    const frozen = frozenStateAt('collected', duration(HOUR));
    expect(
      reject(frozen, { type: 'unfreeze', userIds: ['a', 'a'], resume: 'suspended_from' }, context())
        .failedGuards,
    ).toContain('g_unfreeze_approvers_distinct');
    expect(
      reject(
        frozen,
        { type: 'unfreeze', userIds: ['operator-1', 'b'], resume: 'suspended_from' },
        context({ preparedBy: 'operator-1' }),
      ).failedGuards,
    ).toContain('g_unfreeze_approvers_distinct');
  });

  it('refuses the person who froze the tranche as an approver', () => {
    // Автор заморозки лежит в состоянии, а не в фактах: факты приходят снаружи
    // на каждый вызов, и такой проверки они не выдержат.
    const frozen = frozenStateAt('collected', duration(HOUR), { frozenBy: 'compliance-7' });
    const error = reject(
      frozen,
      { type: 'unfreeze', userIds: ['compliance-7', 'b'], resume: 'suspended_from' },
      context(),
    );
    expect(error.failedGuards).toContain('g_unfreeze_approvers_distinct');
  });
});

describe('поручение, ушедшее в банк, разбирает человек', () => {
  it('allows only release_blocked out of a freeze taken in paying_out or refunding', () => {
    for (const status of ['paying_out', 'refunding'] as const) {
      const frozen = frozenStateAt(status, duration(HOUR));
      for (const resume of ['suspended_from', 'refund_pending'] as const) {
        const error = reject(frozen, { type: 'unfreeze', userIds: ['a', 'b'], resume }, context());
        // Вернуться в «поручение отправлено» значило бы выпустить его второй
        // раз; уйти в возврат — вернуть деньги, которые, возможно, выплачены.
        expect(error.code).toBe(RejectionCode.unfreezeTargetNotAllowed);
      }
      expect(
        accept(frozen, { type: 'unfreeze', userIds: ['a', 'b'], resume: 'release_blocked' }, context())
          .state.status,
      ).toBe('release_blocked');
    }
  });

  it('выражает запрет отсутствием строки, а не проверкой в редьюсере', () => {
    // Раньше строки `frozen --unfreeze--> paying_out` и `... --> refunding` в
    // таблице были, а пускал через них только редьюсер — то есть не пускал
    // никогда. Обход графа в `reachability.test.ts` считал их проходимыми, и
    // снятие проверки правкой в другом месте обход бы не заметил.
    const backIntoDispatched = TRANCHE_TRANSITIONS.filter(
      (item) =>
        item.from === 'frozen' &&
        (DISPATCHED_TRANCHE_STATUSES as readonly string[]).includes(item.to),
    );
    expect(backIntoDispatched).toEqual([]);
  });

  it('не оставляет из frozen ни одного мёртвого ребра', () => {
    // Общее правило, а не частный случай: каждая строка «вернуть туда, откуда
    // заморозили» обязана быть проходимой редьюсером. Мёртвое ребро — это
    // запрет, записанный в двух местах по-разному, и именно так появились
    // `paying_out` и `refunding`.
    let walked = 0;
    for (const edge of TRANCHE_TRANSITIONS) {
      if (edge.from !== 'frozen' || edge.resume !== 'suspended_from') continue;
      const frozen = frozenStateAt(edge.to as ThawedTrancheStatus, duration(HOUR));
      const thawed = accept(
        frozen,
        { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
        context(),
      );
      expect(thawed.state.status).toBe(edge.to);
      walked += 1;
    }
    expect(walked).toBe(RESUMABLE_TRANCHE_STATUSES.length);
    expect(walked).toBeGreaterThan(0);
  });
});

describe('каскад сделка → транши', () => {
  it('is not expressible as a freeze of a freeze', () => {
    const frozen = frozenStateAt('collected', duration(HOUR));
    expect(reject(frozen, hold, context()).code).toBe(RejectionCode.transitionNotAllowed);
  });
});

/**
 * Свойства заморозки проверяются **своим** прогоном со своим пулом событий.
 *
 * `property.test.ts` намеренно не трогается: события заморозки в его пул не
 * добавлены, и любой сдвиг его чисел после E9 означал бы, что заморозка
 * протекла в существующие пути, а не что тест устарел.
 */
describe('свойства заморозки на случайных последовательностях', () => {
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    };
  }

  const FREEZE_POOL = [
    { type: 'compliance_hold', reason: 'sanctions', frozenBy: 'compliance-1' },
    { type: 'compliance_hold', reason: 'compliance_review', frozenBy: 'compliance-2' },
    { type: 'dispute_raised', frozenBy: 'party-1' },
  ] as const;

  it('never lets a freeze add or remove time from the deadline', () => {
    const random = makeRandom(7);
    let checked = 0;
    for (let run = 0; run < 200; run += 1) {
      const status =
        FREEZABLE_TRANCHE_STATUSES[
          Math.floor(random() * FREEZABLE_TRANCHE_STATUSES.length)
        ];
      if (status === undefined) throw new Error('empty pool');
      // `paying_out` и `refunding` выходят только в `release_blocked` — у них
      // остаток не применяется, и они проверяются отдельным примером выше.
      if (status === 'paying_out' || status === 'refunding') continue;

      const span = DEFAULT_DEADLINE_POLICY[status];
      const spent = Math.floor(random() * span * 1.5);
      const freezeAt = at(spent);
      const thawAt = at(spent + Math.floor(random() * 60 * DAY) + 1);
      const event = FREEZE_POOL[Math.floor(random() * FREEZE_POOL.length)];
      if (event === undefined) throw new Error('empty pool');

      const before = stateAt(status);
      const frozen = accept(before, event, context({}, freezeAt)).state;
      expect(frozen.status).toBe('frozen');

      // Пока транш заморожен, ни одно автоматическое событие его не двигает —
      // сколько бы ни прошло времени.
      expect(reject(frozen, { type: 'deadline_reached' }, context({}, thawAt)).code).toBe(
        RejectionCode.transitionNotAllowed,
      );

      const thawed = accept(
        frozen,
        { type: 'unfreeze', userIds: ['a', 'b'], resume: 'suspended_from' },
        context({}, thawAt),
      ).state;
      expect(thawed.status).toBe(status);

      // Неистёкшая часть переносится ровно: заморозка не дарит времени и не
      // отнимает его. Прошедший дедлайн зажимается в минимум — это единственный
      // случай, где равенство превращается в «сработает немедленно».
      const unspent = Math.max(1, deadlineOf(before) - freezeAt);
      expect(deadlineOf(thawed)).toBe(thawAt + unspent);
      checked += 1;
    }
    // Прогон должен был действительно что-то проверить.
    expect(checked).toBeGreaterThan(100);
  });
});
