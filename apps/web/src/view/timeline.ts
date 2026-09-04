import type { DealSnapshot } from '@/fixtures/store';
import type { MoneyState } from '@/view/money-state';

/**
 * Лента сделки — один компонент, два представления по роли (`CABINETS.md` §6).
 * Шаги названы человеческим языком, а не статусами автомата: клиенту нечего
 * делать со словом `release_pending`.
 *
 * Лента — **не восемнадцать шагов** (`DRAFT-money.md` §4). Это семь вех плюс
 * ветка возврата из трёх; состояние определяет, какая веха текущая и что
 * написано под ней. Четыре состояния — `M-03`, `M-04`, `M-13`, `M-18` — вехой
 * не являются вовсе и дают **вставку**: ветка показывается веткой, пауза —
 * вставкой, и ни то ни другое не ошибка (`SCREENS.md` §3.3).
 *
 * Откат показывается веткой: пройденные шаги не исчезают, непройденные
 * помечаются непройденными, и к ленте добавляются шаги отката.
 */
export type StepState = 'done' | 'current' | 'future' | 'missed' | 'branch';

/** Кто держит мяч. Пока в плашке не «вы», от клиента ничего не требуется. */
export type BallHolder = 'us' | 'you' | 'counterparty' | 'registry';

export interface TimelineStep {
  readonly key: string;
  readonly kind: 'step' | 'insert';
  readonly state: StepState;
  readonly at: number | null;
  readonly ball: BallHolder | null;
  /** Подробность шага: источник, дата, номер. Пусто — значит, сказать нечего. */
  readonly detailKey: string | null;
}

const MAIN_STEPS = ['identity', 'property', 'funds', 'reserved', 'filed', 'registered', 'settled'] as const;

const ROLLBACK_STATES = new Set<MoneyState>([
  'rollbackInProgress',
  'releasedToAccount',
  'refundInProgress',
  'refunded',
]);

/**
 * Состояния-вставки. Они не двигают веху: деньги стоят там же, где стояли, но
 * с ними происходит то, чего в семи вехах нет и быть не должно.
 */
const INSERT_STATES = new Set<MoneyState>(['unidentified', 'heldThirdParty', 'payoutUnknown', 'frozen']);

/**
 * Веха, на которой стоит лента. Номера — из `DRAFT-money.md` §5, где у каждого
 * состояния прямо назван текущий или пройденный шаг; здесь они переведены в
 * индексы `MAIN_STEPS` и больше нигде не выводятся заново.
 */
function reachedIndex(deal: DealSnapshot): number {
  switch (deal.moneyState) {
    case 'notFunded':
    case 'transferDeclared':
    case 'unidentified':
    case 'heldThirdParty':
    case 'onAccountFx':
    case 'partiallyFunded':
      return 2;
    case 'onAccount':
    case 'overfunded':
    case 'reserved':
    case 'frozen':
      return 3;
    case 'submitted':
      return 4;
    case 'releasePending':
    case 'payoutUnknown':
      return 6;
    case 'released':
      return MAIN_STEPS.length;
    case 'rollbackInProgress':
    case 'releasedToAccount':
    case 'refundInProgress':
    case 'refunded':
      return 4;
  }
}

function ballOf(deal: DealSnapshot, step: (typeof MAIN_STEPS)[number]): BallHolder {
  const paying = deal.role === 'paying';
  switch (step) {
    case 'identity':
    case 'property':
    case 'reserved':
    case 'settled':
      return 'us';
    case 'funds':
      return paying ? 'you' : 'counterparty';
    case 'filed':
      return paying ? 'counterparty' : 'you';
    case 'registered':
      return 'registry';
  }
}

function markAt(deal: DealSnapshot, index: number): number | null {
  const order = ['collected', 'reserved', 'release_pending', 'paid_out'] as const;
  const status = order[index];
  if (status === undefined) return null;
  return deal.marks.find((mark) => mark.status === status)?.at ?? null;
}

export function buildTimeline(deal: DealSnapshot): readonly TimelineStep[] {
  const raw = reachedIndex(deal);
  // Терминальное состояние: пройдены все вехи, «текущей» нет. Подробность при
  // этом обязана остаться — она про то, чем всё закончилось.
  const terminal = raw >= MAIN_STEPS.length;
  const reached = terminal ? MAIN_STEPS.length - 1 : raw;
  const rollback = ROLLBACK_STATES.has(deal.moneyState);
  const base = `deal.${deal.role}.timeline`;
  const steps: TimelineStep[] = MAIN_STEPS.map((key, index) => {
    const at =
      index === 2
        ? markAt(deal, 0)
        : index === 3
          ? markAt(deal, 1)
          : index === 5
            ? markAt(deal, 2)
            : index === 6
              ? markAt(deal, 3)
              : null;
    const ball = ballOf(deal, key);
    if (rollback && index >= 5) {
      return { key, kind: 'step', state: 'missed', at: null, ball: null, detailKey: null };
    }
    if (index < reached) {
      return { key, kind: 'step', state: 'done', at, ball: null, detailKey: null };
    }
    if (index === reached) {
      return {
        key,
        kind: 'step',
        state: terminal ? 'done' : 'current',
        at,
        ball: terminal ? null : ball,
        // Подробность вехи — про текущее положение денег, а не про шаг вообще:
        // «зачислено», «недобор», «заявление подано» — это разные строки на
        // одном и том же шаге.
        detailKey: INSERT_STATES.has(deal.moneyState) ? null : `${base}.${deal.moneyState}.detail`,
      };
    }
    return { key, kind: 'step', state: 'future', at: null, ball, detailKey: null };
  });

  if (INSERT_STATES.has(deal.moneyState)) {
    steps.splice(reached + 1, 0, {
      key: deal.moneyState,
      kind: 'insert',
      state: 'current',
      at: null,
      ball: 'us',
      detailKey: `${base}.${deal.moneyState}.insert.detail`,
    });
  }

  if (!rollback) {
    return steps;
  }

  const released = deal.marks.find((mark) => mark.status === 'refunded')?.at ?? null;
  const branch: TimelineStep[] = [
    {
      key: 'reserveReleased',
      kind: 'step',
      state: deal.moneyState === 'rollbackInProgress' ? 'current' : 'branch',
      at: released,
      ball: 'us',
      detailKey: deal.moneyState === 'rollbackInProgress' ? `${base}.rollbackInProgress.detail` : null,
    },
  ];
  // У получающей стороны ветка заканчивается на В1: что плательщик делает со
  // своими деньгами после снятия резерва — не дело второй стороны
  // (`DRAFT-money.md` §4).
  if (deal.role === 'paying') {
    branch.push({
      key: 'moneyBack',
      kind: 'step',
      state: deal.moneyState === 'releasedToAccount' ? 'current' : deal.moneyState === 'rollbackInProgress' ? 'future' : 'branch',
      at: released,
      ball: 'us',
      detailKey: deal.moneyState === 'releasedToAccount' ? `${base}.releasedToAccount.detail` : null,
    });
    if (deal.moneyState === 'refundInProgress' || deal.moneyState === 'refunded') {
      branch.push({
        key: 'refunded',
        kind: 'step',
        state: 'current',
        at: released,
        ball: 'us',
        detailKey: `${base}.${deal.moneyState}.detail`,
      });
    }
  }
  return [...steps, ...branch];
}
