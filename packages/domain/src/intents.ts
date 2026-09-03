import type { CurrencyCode, Money } from '@sdelka/money';
import type { Instant } from './instant';

/**
 * Действия при входе и выходе (STATE-MACHINES.md §1.5) — описания намерений,
 * а не вызовы. Редьюсер их только возвращает: внешние вызовы идут через
 * исходящую очередь и никогда внутри транзакции (FUNCTIONAL.md инвариант 15).
 */
export type LedgerTemplate = 'funds_received' | 'payout_with_fee' | 'refund' | 'write_off';

export type Audience = 'buyer' | 'seller' | 'both' | 'operator';

export type Intent =
  | { readonly type: 'set_deadline'; readonly at: Instant }
  | {
      readonly type: 'post_journal_entry';
      readonly template: LedgerTemplate;
      readonly dealId: string;
      readonly trancheId: string;
      readonly amount: Money<CurrencyCode>;
    }
  /** `messageKey` — ключ локализации. Текста для клиента в коде нет. */
  | { readonly type: 'notify'; readonly audience: Audience; readonly messageKey: string }
  | { readonly type: 'lock_beneficiary' }
  | { readonly type: 'unlock_beneficiary' }
  | { readonly type: 'build_payout_instruction'; readonly idempotencyKey: string }
  /**
   * Ссылка на пакет доказательств обязательна по типу: красная линия №5 —
   * выплата без неё невозможна, «просто выплатить» не существует как операция.
   */
  | {
      readonly type: 'enqueue_outbound_payout';
      readonly idempotencyKey: string;
      readonly evidenceBundleId: string;
    }
  | { readonly type: 'enqueue_operator_task'; readonly priorityAmount: Money<CurrencyCode> }
  | { readonly type: 'close_tranche' };

export type IntentType = Intent['type'];
