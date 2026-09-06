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
import type { FeeCeilingPolicy } from '@sdelka/domain';
import type { ClientKey } from '@sdelka/ledger';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { TariffSeries } from '@sdelka/pricing';
import {
  type World,
  emptyWorld,
  toClientKey,
  trancheOptions,
} from '@sdelka/app';
import {
  applyDealEvent,
  createDeal,
  createTranche,
  recordConditionAct,
  recordDecision,
} from './acting';
import {
  CADASTRAL_CODE,
  CONDITION_ACT_SOURCE,
  CREATED_ON,
  DEAL_AMOUNT,
  NOW,
  POLICY,
  POLICY_VERSION,
  SCREENING_SOURCE,
  TARIFF_SERIES,
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
  /**
   * Журнал версий тарифа, которым засеивается мир сценария. По умолчанию —
   * `TARIFF_SERIES`: одна версия, 1,5 %, действующая с 1 сентября.
   *
   * Прежде здесь стояли `deductions` (ставка удержания) и `tariffVersionId`
   * (строка рядом с ней) по отдельности. Теперь и то и другое приходит из
   * журнала версий: сценарий называет **что владелец объявил**, а не то, что
   * приложение потом запишет.
   */
  readonly tariffs?: TariffSeries;
  /**
   * Потолок удержания этого транша. По умолчанию поле не ставится вовсе —
   * действует потолок версии плана (не шире жёстких двух процентов учёта).
   * Сценарий, которому нужен более тесный предел, называет его здесь: политика
   * едет фактом транша до записи расчёта, и проверить это можно только
   * настоящим прогоном. Расширить предел объявление не может — потолки
   * складываются по строжайшему.
   */
  readonly feeCeilingPolicy?: FeeCeilingPolicy;
  readonly sourceAccountKnown?: boolean;
  /** Объект сделки. По умолчанию общий для фикстур: см. `CADASTRAL_CODE`. */
  readonly objectCadastralCode?: string;
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

  // Готовивший больше не поле спецификации: им становится тот, под чьим
  // полномочием заведена сделка. `STAFF.operator` — учётная запись `operator-1`,
  // то есть в фактах домена стоит та же строка, что и прежде, но теперь она
  // выведена из сессии, а не написана здесь.
  let world = createDeal(
    options.world ??
      emptyWorld({
        now: NOW,
        chainId: 'sdelka-audit',
        // Тариф — настройка владельца, и мир без него транша не заводит вовсе.
        tariffs: options.tariffs ?? TARIFF_SERIES,
      }),
    {
      dealId: options.dealId,
      conditionAct: conditionAct(partyRef(options.seller)),
      objectCadastralCode: options.objectCadastralCode ?? CADASTRAL_CODE,
    },
  );

  world = recordDecision(world, options.dealId, {
    subject: auditRef('deal', options.dealId),
    related: [auditRef('party', options.buyer.partyId), auditRef('party', options.seller.partyId)],
    outcome: counterparty.outcome,
    policy: POLICY_VERSION,
    reasonKeys: counterparty.reasons,
    evidence: [CONDITION_ACT_SOURCE],
  });
  for (const item of sanctions) {
    world = recordDecision(world, options.dealId, {
      subject: auditRef('party', item.subjectRef),
      related: [auditRef('deal', options.dealId)],
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
    buyerNames: options.buyer.names,
    // Сумма сделки, а не «сколько перевести»: брутто выводит тариф.
    principal: amount,
    conditionAct: conditionAct(partyRef(options.seller)),
    createdOn: CREATED_ON,
    beneficiary: options.beneficiary ?? beneficiaryFor(options.dealId, options.seller, 500),
    sourceAccountKnown: options.sourceAccountKnown ?? true,
    ...(options.feeCeilingPolicy === undefined
      ? {}
      : { feeCeilingPolicy: options.feeCeilingPolicy }),
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
