import type { ClientKey, DealPartiesAttestation, TrancheRef } from '@sdelka/ledger';

/**
 * Подтверждение сторон транша — работа домена, а не учёта и не тарифа.
 *
 * `DealPartiesAttestation` устроен так, что построить его кодом нельзя:
 * ambient-ключ, значения которого не существует. Единственный вход — приведение
 * типа, и в `src/` этого пакета его нет ни одного (как нет и в `src/` учёта).
 * Здесь оно стоит по той же причине, по которой стоит в тестах учёта: тарифу
 * нужно предъявить учёту то, что ни тот, ни другой изготовить не могут.
 */
export function attestDealParties(
  deal: TrancheRef,
  payer: ClientKey,
  recipient: ClientKey,
  evidenceRef = 'evidence-1',
): DealPartiesAttestation {
  return {
    dealId: deal.dealId,
    trancheId: deal.trancheId,
    payer,
    recipient,
    evidenceRef,
  } as unknown as DealPartiesAttestation;
}
