import type { DealSnapshot } from '@/fixtures/store';

/**
 * Блок «что требуется от вас сейчас»: **ровно одно действие**, не список
 * (`CABINETS.md` §3.2). Если действий нет — сказано, чего именно и от кого мы
 * ждём; формулировка «ждите» без субъекта и срока запрещена.
 *
 * Единственное исключение — возврат средств на счёт: там два исхода равноправны
 * по смыслу, и выбор за клиентом. Подталкивать к повтору сделки в момент
 * разочарования нельзя: это читается как манипуляция.
 */
export type ActionKind = 'action' | 'waiting' | 'dual' | 'blocked' | 'none';

export interface RequiredAction {
  readonly kind: ActionKind;
  /** Ключ заголовка блока. */
  readonly titleKey: string;
  /** Ключ метки основного действия, если оно есть. */
  readonly ctaKey: string | null;
  /** Второе равнозначное действие: только для возврата на счёт. */
  readonly secondaryCtaKey: string | null;
  /** Причина недоступности: рядом с заблокированным действием она обязательна. */
  readonly reasonKey: string | null;
}

function key(deal: DealSnapshot, tail: string): string {
  return `deal.${deal.role}.action.${tail}`;
}

export function requiredAction(deal: DealSnapshot): RequiredAction {
  const paying = deal.role === 'paying';

  if (deal.property.hasMismatch && deal.moneyState === 'notFunded') {
    return {
      kind: 'blocked',
      titleKey: key(deal, 'mismatch.title'),
      ctaKey: key(deal, 'topup.cta'),
      secondaryCtaKey: null,
      reasonKey: key(deal, 'mismatch.reason'),
    };
  }

  if (deal.modifiers.quoteExpired && paying) {
    return {
      kind: 'action',
      titleKey: key(deal, 'requote.title'),
      ctaKey: key(deal, 'requote.cta'),
      secondaryCtaKey: null,
      reasonKey: null,
    };
  }

  const waiting = (tail: string): RequiredAction => ({
    kind: 'waiting',
    titleKey: key(deal, `waiting.${tail}`),
    ctaKey: null,
    secondaryCtaKey: null,
    reasonKey: null,
  });

  const act = (tail: string): RequiredAction => ({
    kind: 'action',
    titleKey: key(deal, `${tail}.title`),
    ctaKey: key(deal, `${tail}.cta`),
    secondaryCtaKey: null,
    reasonKey: null,
  });

  switch (deal.moneyState) {
    case 'notFunded':
      return paying ? act('topup') : waiting('payerFunds');
    case 'transferDeclared':
      return waiting('bank');
    case 'unidentified':
      return paying ? act('proveTransfer') : waiting('payerFunds');
    case 'heldThirdParty':
      return paying ? act('thirdParty') : waiting('payerFunds');
    case 'onAccountFx':
      return paying ? act('confirmRate') : waiting('payerFunds');
    case 'partiallyFunded':
      return paying ? act('topupRest') : waiting('payerFunds');
    case 'onAccount':
    case 'overfunded':
      return waiting('reserve');
    case 'reserved':
      return paying ? waiting('filing') : act('submitDocuments');
    case 'submitted':
      return waiting('registry');
    case 'releasePending':
      return waiting('settlement');
    case 'payoutUnknown':
      return waiting('reconciliation');
    case 'released':
      return { kind: 'none', titleKey: key(deal, 'done'), ctaKey: null, secondaryCtaKey: null, reasonKey: null };
    case 'rollbackInProgress':
      return waiting('rollback');
    case 'releasedToAccount':
      return paying
        ? {
            kind: 'dual',
            titleKey: key(deal, 'released.title'),
            ctaKey: key(deal, 'withdraw.cta'),
            secondaryCtaKey: key(deal, 'restart.cta'),
            reasonKey: null,
          }
        : waiting('restart');
    case 'refundInProgress':
      return waiting('bankRefund');
    case 'refunded':
      return { kind: 'none', titleKey: key(deal, 'done'), ctaKey: null, secondaryCtaKey: null, reasonKey: null };
    case 'frozen':
      return act('support');
  }
}
