import type { DealSnapshot } from '@/fixtures/store';

/**
 * Лента сделки — один компонент, два представления по роли (`CABINETS.md` §6).
 * Шаги названы человеческим языком, а не статусами автомата: клиенту нечего
 * делать со словом `release_pending`.
 *
 * Откат показывается **веткой, а не ошибкой**: пройденные шаги не исчезают,
 * непройденные помечаются непройденными, и к ленте добавляются шаги отката.
 */
export type StepState = 'done' | 'current' | 'future' | 'missed' | 'branch';

export interface TimelineStep {
  readonly key: string;
  readonly state: StepState;
  readonly at: number | null;
}

const MAIN_STEPS = ['identity', 'property', 'funds', 'reserved', 'filed', 'registered', 'settled'] as const;

const ROLLBACK_STATES = new Set([
  'rollbackInProgress',
  'releasedToAccount',
  'refundInProgress',
  'refunded',
]);

function reachedIndex(deal: DealSnapshot): number {
  switch (deal.moneyState) {
    case 'notFunded':
    case 'transferDeclared':
    case 'unidentified':
    case 'heldThirdParty':
    case 'onAccountFx':
    case 'partiallyFunded':
      return 1;
    case 'onAccount':
    case 'overfunded':
      return 2;
    case 'reserved':
      return 3;
    case 'submitted':
      return 4;
    case 'releasePending':
    case 'payoutUnknown':
      return 5;
    case 'released':
      return 6;
    case 'frozen':
      return 3;
    case 'rollbackInProgress':
    case 'releasedToAccount':
    case 'refundInProgress':
    case 'refunded':
      return 4;
  }
}

function markAt(deal: DealSnapshot, index: number): number | null {
  const order = ['collected', 'reserved', 'release_pending', 'paid_out'] as const;
  const status = order[index];
  if (status === undefined) return null;
  return deal.marks.find((mark) => mark.status === status)?.at ?? null;
}

export function buildTimeline(deal: DealSnapshot): readonly TimelineStep[] {
  const reached = reachedIndex(deal);
  const rollback = ROLLBACK_STATES.has(deal.moneyState);
  const steps: TimelineStep[] = MAIN_STEPS.map((key, index) => {
    const at =
      index === 2 ? markAt(deal, 0) : index === 3 ? markAt(deal, 1) : index === 5 ? markAt(deal, 2) : index === 6 ? markAt(deal, 3) : null;
    if (rollback && index >= 5) {
      return { key, state: 'missed', at: null };
    }
    if (index < reached) return { key, state: 'done', at };
    if (index === reached) return { key, state: 'current', at };
    return { key, state: 'future', at: null };
  });
  if (!rollback) {
    return steps;
  }
  const released = deal.marks.find((mark) => mark.status === 'refunded')?.at ?? null;
  return [
    ...steps,
    { key: 'reserveReleased', state: 'branch', at: released },
    {
      key: 'moneyBack',
      state: deal.moneyState === 'rollbackInProgress' ? 'current' : 'branch',
      at: released,
    },
  ];
}
