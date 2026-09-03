import type { ClientKey, DealPartiesAttestation, TrancheRef } from '../../src/index';

/**
 * Подтверждение сторон транша — **работа домена, а не учёта**.
 *
 * `DealPartiesAttestation` устроен так, что построить его кодом нельзя: у него
 * ambient-ключ, значения которого не существует. Единственный способ получить
 * значение — приведение типа, и приведение это обязано стоять ровно там, где
 * знание о составе сторон живёт: в автомате сделки. В `src/` учёта такого
 * приведения нет ни одного — и это проверяемое свойство, а не обещание.
 *
 * Здесь оно стоит по той же причине, по которой существует `uncheckedEntry`:
 * тестам учёта нужно предъявить то, что учёт по построению изготовить не может.
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
