import type { CurrencyCode, Money } from '@sdelka/money';
import type { ConditionAct } from './condition-act';
import type { ReleaseConditionType } from './release-condition';

export type PayoutOutcome = 'settled' | 'rejected' | 'unknown';
export type ReconciliationOutcome = 'settled' | 'rejected';

/**
 * События транша — STATE-MACHINES.md §1.2, буква в букву.
 *
 * Три события помечены как введённые кодом: документ описывает соответствующие
 * переходы условием в квадратных скобках и не даёт им имени (§1.4). Без имени
 * переход невозможно вызвать, поэтому имена введены здесь и вынесены в отчёт
 * как расхождение с документом, а не молча.
 */
export type TrancheEvent =
  /** введено кодом: §1.4 «pending → collecting [инструкции выданы]» */
  | { readonly type: 'instructions_issued' }
  | {
      readonly type: 'funds_received';
      readonly amount: Money<CurrencyCode>;
      readonly sender: string;
      readonly reference: string;
    }
  | { readonly type: 'reserve_requested' }
  | { readonly type: 'reserve_expired' }
  | { readonly type: 'revocation_requested'; readonly actor: 'buyer' }
  | {
      readonly type: 'condition_established';
      readonly evidenceBundleId: string;
      readonly conditionType: ReleaseConditionType;
    }
  | { readonly type: 'condition_failed' }
  | { readonly type: 'mismatch_detected'; readonly field: string }
  | { readonly type: 'approval_added'; readonly userId: string }
  | { readonly type: 'operator_blocked'; readonly reason: string }
  /** введено кодом: §1.4 «release_pending → paying_out» задан только guard'ами */
  | { readonly type: 'release_authorized' }
  /** введено кодом: §1.4 «refund_pending → refunding» задан только guard'ом */
  | { readonly type: 'refund_initiated' }
  | { readonly type: 'payout_result'; readonly outcome: PayoutOutcome }
  | { readonly type: 'reconciliation_resolved'; readonly outcome: ReconciliationOutcome }
  | { readonly type: 'deadline_reached' }
  | { readonly type: 'refund_requested'; readonly reason: string }
  | { readonly type: 'write_off_approved'; readonly userIds: readonly string[] }
  /**
   * введено кодом (E11-4, CORE.md Ф13): изменение условия после внесения
   * средств возможно только новым актом **обеих сторон**. Событие не двигает
   * состояние — оно перепривязывает акт, под которым транш принял деньги.
   */
  | {
      readonly type: 'condition_act_amended';
      readonly act: ConditionAct;
      /** Ключи сторон, принявших новую редакцию: покупатель и получатель. */
      readonly acceptedBy: readonly string[];
    };

export type TrancheEventType = TrancheEvent['type'];
