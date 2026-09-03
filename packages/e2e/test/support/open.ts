import { auditRef } from '@sdelka/audit';
import {
  type BeneficiaryState,
  type CounterpartyFacts,
  type DetectorOutcome,
  type PartyProfile,
  type SanctionsDecision,
  type SanctionsScreeningPort,
  assessCounterparty,
  combineOutcomes,
  decideSanctions,
  payerKeyForDomain,
  sanctionsToDetectorOutcome,
} from '@sdelka/compliance';
import type { ClientKey } from '@sdelka/ledger';
import type { CurrencyCode, Deduction, Money } from '@sdelka/money';
import {
  type World,
  ANALYST_ACTOR,
  OPERATOR_ACTOR,
  applyDealEvent,
  createDeal,
  createTranche,
  emptyWorld,
  recordConditionAct,
  recordDecision,
  toClientKey,
  trancheOptions,
} from '../../src/index';
import {
  CONDITION_ACT_SOURCE,
  CREATED_ON,
  DEAL_AMOUNT,
  NOW,
  PLATFORM_FEE,
  POLICY,
  POLICY_VERSION,
  SCREENING_SOURCE,
  beneficiaryFor,
  cleanScreening,
  conditionAct,
  evidenceRef,
  partyRef,
} from './fixtures';

/**
 * Общее начало всех сценариев: проверка сторон, заведение сделки и транша,
 * акт получателя об условии и выдача инструкций на оплату.
 *
 * Комплаенс здесь настоящий: исход считают `assessCounterparty` и
 * `decideSanctions`, а не фикстура. Подставляется только ответ провайдера
 * скрининга — он и есть внешний источник.
 */
export interface OpenOptions {
  readonly dealId: string;
  readonly trancheId: string;
  readonly buyer: PartyProfile;
  readonly seller: PartyProfile;
  readonly amount?: Money<CurrencyCode>;
  readonly screening?: SanctionsScreeningPort;
  readonly beneficiary?: BeneficiaryState;
  readonly deductions?: readonly Deduction[];
  readonly sourceAccountKnown?: boolean;
  readonly world?: World;
}

export interface OpenedDeal {
  readonly world: World;
  readonly dealId: string;
  readonly trancheId: string;
  readonly buyerKey: ClientKey;
  readonly sellerKey: ClientKey;
  readonly admission: DetectorOutcome;
  readonly sanctions: readonly SanctionsDecision[];
}

const OPTIONS = trancheOptions(POLICY_VERSION);

export async function openDeal(options: OpenOptions): Promise<OpenedDeal> {
  const screening = options.screening ?? cleanScreening();
  const amount = options.amount ?? DEAL_AMOUNT;
  const buyerKey = toClientKey(options.buyer.document);
  const sellerKey = toClientKey(options.seller.document);

  const counterpartyFacts: CounterpartyFacts = {
    participations: [
      { partyId: options.buyer.partyId, role: 'payer', document: options.buyer.document },
      { partyId: options.seller.partyId, role: 'recipient', document: options.seller.document },
    ],
    relation: { kind: 'unrelated' },
    nameMatch: null,
    evidence: [evidenceRef(1, 'contract')],
  };
  const counterparty = assessCounterparty(counterpartyFacts, POLICY_VERSION, NOW);

  const sanctions: SanctionsDecision[] = [];
  for (const party of [options.buyer, options.seller]) {
    const response = await screening.screen({
      subjectRef: party.partyId,
      names: party.names,
      nationalities: party.nationalities,
      lists: POLICY.sanctions.lists,
      requestedAt: NOW,
      policyVersionId: POLICY_VERSION,
    });
    sanctions.push(
      decideSanctions(
        {
          subjectRef: party.partyId,
          subjectNames: party.names,
          subjectNationalities: party.nationalities,
          response,
          whitelist: [],
          evidence: [],
        },
        POLICY,
        NOW,
      ),
    );
  }

  const admission = combineOutcomes([
    counterparty.outcome,
    ...sanctions.map((item) => sanctionsToDetectorOutcome(item.outcome)),
  ]);

  let world = createDeal(options.world ?? emptyWorld({ now: NOW, chainId: 'sdelka-audit' }), {
    dealId: options.dealId,
    conditionAct: conditionAct(partyRef(options.seller)),
    preparedBy: 'operator-1',
  });

  world = recordDecision(world, {
    subject: auditRef('deal', options.dealId),
    related: [auditRef('party', options.buyer.partyId), auditRef('party', options.seller.partyId)],
    actor: ANALYST_ACTOR,
    outcome: counterparty.outcome,
    policy: POLICY_VERSION,
    reasonKeys: counterparty.reasons,
    evidence: [CONDITION_ACT_SOURCE],
  });
  for (const item of sanctions) {
    world = recordDecision(world, {
      subject: auditRef('party', item.subjectRef),
      related: [auditRef('deal', options.dealId)],
      actor: ANALYST_ACTOR,
      outcome: item.outcome,
      policy: POLICY_VERSION,
      reasonKeys: item.reasons,
      evidence: [SCREENING_SOURCE],
    });
  }

  if (admission === 'block') {
    // Деньги не заводятся вовсе: транша нет, журнал пуст, сделка отменена.
    // Отмена возможна только до появления денег — здесь их и не было.
    world = applyDealEvent(world, options.dealId, { type: 'cancellation_requested' }, OPTIONS);
    return { world, dealId: options.dealId, trancheId: options.trancheId, buyerKey, sellerKey, admission, sanctions };
  }

  world = createTranche(world, {
    dealId: options.dealId,
    trancheId: options.trancheId,
    buyer: partyRef(options.buyer),
    buyerPayerKey: payerKeyForDomain(options.buyer.document),
    requiredAmount: amount,
    conditionAct: conditionAct(partyRef(options.seller)),
    createdOn: CREATED_ON,
    deductions: options.deductions ?? PLATFORM_FEE,
    beneficiary: options.beneficiary ?? beneficiaryFor(options.seller, 500),
    preparedBy: 'operator-1',
    sourceAccountKnown: options.sourceAccountKnown ?? true,
  });

  world = recordConditionAct(
    world,
    options.dealId,
    options.trancheId,
    conditionAct(partyRef(options.seller)),
    CONDITION_ACT_SOURCE,
    POLICY_VERSION,
  );

  world = applyDealEvent(world, options.dealId, { type: 'parties_check_started' }, OPTIONS);
  world = applyDealEvent(world, options.dealId, { type: 'parties_verified' }, OPTIONS);
  world = applyDealEvent(world, options.dealId, { type: 'property_verified' }, OPTIONS);

  return { world, dealId: options.dealId, trancheId: options.trancheId, buyerKey, sellerKey, admission, sanctions };
}

export { OPERATOR_ACTOR };
