import { money } from '@sdelka/money';
import { describe, expect, it } from 'vitest';
import {
  type ReviewTask,
  type SanctionsCandidate,
  type SanctionsPossibleMatch,
  ALL_REASON_KEYS,
  ANALYST_ROLE,
  APPROVER_ROLE,
  DEFAULT_NAME_FEATURE_WEIGHTS,
  GENERIC_DUAL_CONTROL_REASONS,
  OPERATOR_ROLE,
  POLICY_2026_09_03,
  SUPPORT_ROLE,
  actor,
  addNameObservation,
  adjudicateSanctions,
  advanceBeneficiaryChange,
  applyBeneficiaryChange,
  assessCounterparty,
  assessFlipping,
  assessLinkage,
  assessPayer,
  assessPrice,
  assessRefundDestination,
  assessStructuring,
  authorize,
  compareNames,
  decideSanctions,
  decision,
  distinctApprovers,
  dualControlFailures,
  escalatedTasks,
  evaluateConcentration,
  findPartyLinks,
  findStructuringClusters,
  grantImpersonation,
  identityCompleteness,
  latinAmbiguity,
  lockOnFunding,
  logSafeDecision,
  logSafeNameMatch,
  nameDigest,
  nameObservation,
  openBeneficiaryChange,
  prioritize,
  reconcileOwner,
  runDetectors,
  supportPartyView,
  toBeneficiaryConfirmation,
  verifyBeneficiaryHolder,
} from '../src/index';
import {
  ACCOUNT_SOURCE,
  ACCOUNT_THIRD,
  BUYER_DOCUMENT,
  BUYER_NAMES,
  BY,
  DEVICE_SHARED,
  document,
  evidence,
  latinName,
  NOW,
  OTHER_DOCUMENT,
  OTHER_NAMES,
  PARTICIPATION,
  POLICY,
  POLICY_VERSION,
  RU,
  profile,
} from './support/fixtures';

/**
 * Неизменяемость значений, которые пакет отдаёт наружу.
 *
 * Решение комплаенса живёт дольше вызова: оно уходит в очередь, в журнал и в
 * карточку оператора, и по дороге его читают несколько слоёв. Значение, которое
 * считалось неизменяемым, а на деле правится, — это решение, отличающееся от
 * записанного, причём **без единой записи о правке** (красная линия №11: журнал
 * не редактируется, исправление — только новой записью).
 *
 * `Object.freeze` неглубок: замороженный объект со ссылкой на живой массив
 * защищён только с виду. Поэтому проверка обходит всё дерево целиком и
 * называет путь до первого места, где заморозка кончилась.
 *
 * Все входы замораживаются до вызова: пакет отвечает за то, что создал сам,
 * и если незамороженным окажется узел выхода — он собран здесь, а не принесён.
 */
function freezeDeep<T>(value: T, seen: Set<unknown> = new Set()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item, seen);
  return Object.freeze(value);
}

function mutablePaths(value: unknown, path = 'значение', seen: Set<unknown> = new Set()): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const found: string[] = Object.isFrozen(value) ? [] : [path];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    found.push(...mutablePaths(item, `${path}.${key}`, seen));
  }
  return found;
}

const strong = { strongThresholdBp: POLICY.nameThresholds.ownerReconciliation.valueBp };
const nameMatch = () => compareNames(BUYER_NAMES, BUYER_NAMES, strong);
const support = actor('support-1', SUPPORT_ROLE);
const writer = authorize(actor('operator-1', OPERATOR_ROLE), 'write_beneficiary');
const approver = authorize(actor('approver-1', APPROVER_ROLE), 'approve_beneficiary_change');
const analyst = authorize(actor('analyst-1', ANALYST_ROLE), 'adjudicate_screening');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const requisites = freezeDeep({
  account: ACCOUNT_SOURCE,
  holderNames: BUYER_NAMES,
  holderDocument: null,
  ownershipEvidence: null,
});

const beneficiaryState = freezeDeep({
  requisites,
  // Реквизиты принадлежат участию, а не лицу: без ключа участия состояние
  // теперь не собрать (И13.1).
  participation: PARTICIPATION,
  status: 'name_consistent' as const,
  locked: true,
  lastChangedAt: null,
});

const candidate: SanctionsCandidate = freezeDeep({
  listSource: 'us_ofac' as const,
  listEntryId: 'entry-1',
  listEntryVersion: 'v1',
  entryType: 'person' as const,
  matchedFields: ['name' as const],
  providerScoreBp: 9_000,
  programmes: ['PROGRAMME-1'],
  listNames: null,
});

const screeningResponse = freezeDeep({
  kind: 'completed' as const,
  candidates: [candidate],
  providerReference: 'provider-ref-1',
  rawResponseRef: 'raw-1',
  screenedAt: NOW,
});

const possibleMatch = (): SanctionsPossibleMatch => decideSanctions(
  freezeDeep({
    subjectRef: 'party-1',
    subjectNames: BUYER_NAMES,
    subjectNationalities: [],
    response: screeningResponse,
    whitelist: [],
    evidence: [evidence(1)],
  }),
  POLICY,
  NOW,
) as SanctionsPossibleMatch;

const task = (taskId: string, hoursAgo: number): ReviewTask =>
  freezeDeep({
    taskId,
    kind: 'payer_hold' as const,
    dealId: 'deal-1',
    trancheId: null,
    partyId: null,
    withdrawalId: null,
    rankAmount: money('GEL', 10_000_000n),
    enteredAt: (NOW - hoursAgo * HOUR_MS) as typeof NOW,
    deadlineAt: null,
    severity: 'hold' as const,
    assigneeId: null,
    policyVersionId: POLICY.version,
  });

const changeRequest = freezeDeep({
  requestId: 'change-1',
  requestedBy: 'operator-1',
  requestedAt: (NOW - 48 * HOUR_MS) as typeof NOW,
  proposed: requisites,
  status: 'cooling_off' as const,
  reverifiedAt: NOW,
  notifiedAt: NOW,
  approvals: ['approver-1'],
  policyVersionId: POLICY.version,
});

/**
 * Значение и то, чем оно получено. Случай ленив намеренно: `freezeDeep` над
 * входом одного случая заморозил бы значение другого, будь они посчитаны разом,
 * и проверка отчиталась бы о заморозке, которой в коде нет.
 *
 * Обёртка `Result` из `@sdelka/domain` разворачивается: конверт «получилось или
 * нет» — контракт домена, и проверяется он там; здесь проверяется то, что
 * положил внутрь комплаенс.
 */
const CASES: readonly (readonly [string, () => unknown])[] = [
  [
    'политика',
    () =>
      POLICY_2026_09_03,
  ],
  [
    'реестр ключей причин',
    () =>
      ALL_REASON_KEYS,
  ],
  [
    'веса признаков имени',
    () =>
      DEFAULT_NAME_FEATURE_WEIGHTS,
  ],
  [
    'причины второго утверждения',
    () =>
      GENERIC_DUAL_CONTROL_REASONS,
  ],
  [
    'роль поддержки',
    () =>
      SUPPORT_ROLE,
  ],
  [
    'актор',
    () =>
      support,
  ],
  [
    'доказательство полномочия',
    () =>
      authorize(support, 'read_party'),
  ],
  [
    'проекция профиля для поддержки',
    () =>
      supportPartyView(freezeDeep(profile()), authorize(support, 'read_party')),
  ],
  [
    'сессия от имени клиента',
    () =>
      grantImpersonation(
      authorize(support, 'act_on_behalf'),
      freezeDeep({ grantId: 'g1', partyId: 'party-1', consentRef: 'consent-1', ttlMs: 60_000 }),
      NOW,
    ),
  ],
  [
    'решение',
    () =>
      decision('clear', POLICY_VERSION, NOW, [], freezeDeep([evidence(1)])),
  ],
  [
    'журнальная проекция решения',
    () =>
      logSafeDecision(
        decision('clear', POLICY_VERSION, NOW, [], freezeDeep([evidence(1), evidence(2)])),
      ),
  ],
  [
    'полнота профиля',
    () =>
      identityCompleteness(freezeDeep(profile({ kyc: 'basic' })), NOW),
  ],
  [
    'сверка собственника',
    () =>
      reconcileOwner('matched', nameMatch()),
  ],
  [
    'сравнение имён',
    () =>
      nameMatch(),
  ],
  [
    'журнальная проекция сравнения имён',
    () =>
      logSafeNameMatch(nameMatch()),
  ],
  [
    'дайджест имени',
    () =>
      nameDigest('latin', 'Sabo', 'Tikato'),
  ],
  [
    'наблюдение имени',
    () =>
      nameObservation(freezeDeep(latinName('Sabo', 'Tikato'))),
  ],
  [
    'набор наблюдений',
    () =>
      addNameObservation(BUYER_NAMES, freezeDeep(latinName('Sabo', 'Tikato'))),
  ],
  [
    'разбор неоднозначности',
    () =>
      latinAmbiguity('tikato'),
  ],
  [
    'детектор плательщика',
    () =>
      assessPayer(
      freezeDeep({
        buyerDocument: BUYER_DOCUMENT,
        origin: {
          kind: 'external_transfer' as const,
          payerDocument: OTHER_DOCUMENT,
          senderNameMatch: nameMatch(),
        },
        relationship: { kind: 'spouse' as const, proof: { document: evidence(2, 'kinship_document'), verified: true }, payerKyc: 'complete' as const },
        evidence: [evidence(1)],
      }),
      POLICY_VERSION,
      NOW,
    ),
  ],
  [
    'детектор возврата',
    () =>
      assessRefundDestination(
      freezeDeep({
        sourceAccount: ACCOUNT_SOURCE,
        sourceHolder: BUYER_DOCUMENT,
        requestedAccount: ACCOUNT_SOURCE,
        requestedHolder: BUYER_DOCUMENT,
        sanctionsFrozen: false,
        evidence: [evidence(1)],
      }),
      POLICY_VERSION,
      NOW,
    ),
  ],
  [
    'детектор цены',
    () =>
      assessPrice(
      freezeDeep({
        contractPrice: money('GEL', 24_000_000n),
        platformAmount: money('GEL', 25_000_000n),
        differentAmountRequested: false,
        evidence: [evidence(1, 'contract')],
      }),
      POLICY_VERSION,
      POLICY.price,
      NOW,
    ),
  ],
  [
    'кластеры дробления',
    () =>
      findStructuringClusters(
      freezeDeep({
        payments: [1, 2, 3].map((index) => ({
          paymentId: `p${index}`,
          payerKey: 'payer-1',
          amount: money('GEL', 1_200_000n),
          receivedAt: (NOW - index * DAY_MS) as typeof NOW,
        })),
        evidence: [],
      }),
      POLICY.structuring,
    ),
  ],
  [
    'детектор дробления',
    () =>
      assessStructuring(freezeDeep({ payments: [], evidence: [] }), POLICY_VERSION, POLICY.structuring, NOW),
  ],
  [
    'связи сторон',
    () =>
      findPartyLinks(
      freezeDeep({
        parties: [
          {
            partyId: 'a',
            identity: BUYER_DOCUMENT,
            accounts: [ACCOUNT_THIRD],
            devices: [DEVICE_SHARED],
            networkAddresses: [],
            phones: [],
          },
          {
            partyId: 'b',
            identity: document(8),
            accounts: [ACCOUNT_THIRD],
            devices: [DEVICE_SHARED],
            networkAddresses: [],
            phones: [],
          },
        ],
        declaredRelationships: [],
        evidence: [],
      }),
    ),
  ],
  [
    'детектор связанности',
    () =>
      assessLinkage(
      freezeDeep({ parties: [], declaredRelationships: [], evidence: [] }),
      POLICY_VERSION,
      NOW,
    ),
  ],
  [
    'детектор перепродажи',
    () =>
      assessFlipping(
      freezeDeep({
        cadastralCode: 'code-1',
        currentPrice: money('GEL', 24_000_000n),
        priorTransfers: [
          {
            transferId: 't-1',
            cadastralCode: 'code-1',
            registeredAt: (NOW - 10 * DAY_MS) as typeof NOW,
            price: money('GEL', 10_000_000n),
          },
        ],
        evidence: [],
      }),
      POLICY_VERSION,
      POLICY.flipping,
      NOW,
    ),
  ],
  [
    'детектор одной личности по обе стороны',
    () =>
      assessCounterparty(
      freezeDeep({
        participations: [
          { partyId: 'p', role: 'payer' as const, document: BUYER_DOCUMENT },
          { partyId: 'r', role: 'recipient' as const, document: BUYER_DOCUMENT },
        ],
        relation: { kind: 'unrelated' as const },
        nameMatch: null,
        evidence: [],
      }),
      POLICY_VERSION,
      NOW,
    ),
  ],
  [
    'сводный прогон детекторов',
    () =>
      runDetectors(
      freezeDeep({
        payer: null,
        refund: null,
        price: {
          contractPrice: money('GEL', 24_000_000n),
          platformAmount: money('GEL', 24_000_000n),
          differentAmountRequested: false,
          evidence: [evidence(1, 'contract')],
        },
        structuring: null,
        linkage: null,
        flipping: null,
        counterparty: null,
      }),
      POLICY,
      NOW,
    ),
  ],
  [
    'санкции: возможное совпадение',
    () =>
      possibleMatch(),
  ],
  [
    'санкции: разбор аналитика',
    () =>
      adjudicateSanctions(possibleMatch(), 'false_positive', analyst, 'rationale-1', POLICY, NOW),
  ],
  [
    'санкции: провайдер недоступен',
    () =>
      decideSanctions(
      freezeDeep({
        subjectRef: 'party-1',
        subjectNames: BUYER_NAMES,
        subjectNationalities: [],
        response: { kind: 'unavailable' as const, providerReference: null },
        whitelist: [],
        evidence: [],
      }),
      POLICY,
      NOW,
    ),
  ],
  [
    'сверка владельца счёта',
    () =>
      verifyBeneficiaryHolder(PARTICIPATION, requisites, freezeDeep(profile()), POLICY, NOW),
  ],
  [
    'блокировка реквизитов',
    () =>
      lockOnFunding(beneficiaryState),
  ],
  [
    'факт для guard-а домена',
    () =>
      toBeneficiaryConfirmation(beneficiaryState),
  ],
  [
    'заявка на изменение реквизитов',
    () =>
      openBeneficiaryChange(
      beneficiaryState,
      freezeDeep({
        requestId: 'change-1',
        proposed: requisites,
        releaseAt: (NOW + 30 * DAY_MS) as typeof NOW,
        dealFunded: true,
      }),
      writer,
      POLICY,
      NOW,
    ),
  ],
  [
    'заявка, заблокированная окном релиза',
    () =>
      openBeneficiaryChange(
      beneficiaryState,
      freezeDeep({ requestId: 'change-2', proposed: requisites, releaseAt: null, dealFunded: true }),
      writer,
      POLICY,
      NOW,
    ),
  ],
  [
    'движение заявки',
    () =>
      advanceBeneficiaryChange(changeRequest, freezeDeep({ type: 'approval_added' as const, userId: 'approver-2' }), NOW),
  ],
  [
    'применение изменения реквизитов',
    () =>
      applyBeneficiaryChange(
      beneficiaryState,
      changeRequest,
      freezeDeep({ releaseAt: (NOW + 30 * DAY_MS) as typeof NOW, dealFunded: true, locked: true }),
      approver,
      POLICY,
      NOW,
    ),
  ],
  [
    'применение изменения: отказ',
    () =>
      applyBeneficiaryChange(
      beneficiaryState,
      freezeDeep({ ...changeRequest, reverifiedAt: null }),
      freezeDeep({ releaseAt: (NOW + 30 * DAY_MS) as typeof NOW, dealFunded: true, locked: true }),
      approver,
      POLICY,
      NOW,
    ),
  ],
  [
    'концентрация',
    () =>
      evaluateConcentration(
      freezeDeep({
        year: 2026,
        month: 9,
        currency: 'GEL' as const,
        totalMinor: 100_000_000n,
        byCountry: [
          { country: RU, minor: 30_000_000n },
          { country: BY, minor: 10_000_000n },
        ],
      }),
      POLICY.concentration,
    ),
  ],
  [
    'очередь: приоритет',
    () =>
      prioritize(freezeDeep([task('t-1', 100), task('t-2', 1)]), POLICY.queue, NOW),
  ],
  [
    'очередь: эскалированные',
    () =>
      escalatedTasks(freezeDeep([task('t-1', 100)]), POLICY.queue, NOW),
  ],
  [
    'годные утверждающие',
    () =>
      distinctApprovers(freezeDeep({ preparedBy: 'operator-1', approvals: ['approver-1', 'approver-1'] })),
  ],
  [
    'причины второго утверждения',
    () =>
      dualControlFailures(
      freezeDeep({ preparedBy: 'operator-1', approvals: [], requiredApprovals: 1 as const }),
      GENERIC_DUAL_CONTROL_REASONS,
      'operator-1',
    ),
  ],
];


/**
 * Ветви исхода — отдельные места сборки значения.
 *
 * Каждая ветвь собирает свой объект своим `Object.freeze`, и заморозка,
 * снятая на одной из них, не видна ни на какой другой: детектор продолжает
 * возвращать неизменяемые решения — кроме того случая, ради которого его и
 * писали. Поэтому ветви перечислены поимённо, а не представлены одной.
 */
const BRANCH_CASES: readonly (readonly [string, () => unknown])[] = [
  ...payerBranches(),
  ...priceBranches(),
  ...refundBranches(),
  ...flippingBranches(),
  ...counterpartyBranches(),
  ...screeningBranches(),
  ...beneficiaryBranches(),
  ...ownerBranches(),
  ...concentrationBranches(),
  [
    'сравнение имён: сравнивать нечего',
    () => compareNames([], BUYER_NAMES, strong),
  ],
  [
    'полнота профиля: всё на месте',
    () => identityCompleteness(freezeDeep(profile()), NOW),
  ],
  [
    'дробление: кластер найден',
    () =>
      assessStructuring(
        freezeDeep({
          payments: [1, 2, 3].map((index) => ({
            paymentId: `p${index}`,
            payerKey: 'payer-1',
            amount: money('GEL', 1_200_000n),
            receivedAt: (NOW - index * DAY_MS) as typeof NOW,
          })),
          evidence: [],
        }),
        POLICY_VERSION,
        POLICY.structuring,
        NOW,
      ),
  ],
  [
    'связанность: общий счёт у формально независимых сторон',
    () =>
      assessLinkage(
        freezeDeep({
          parties: [
            {
              partyId: 'a',
              identity: BUYER_DOCUMENT,
              accounts: [ACCOUNT_THIRD],
              devices: [],
              networkAddresses: [],
              phones: [],
            },
            {
              partyId: 'b',
              identity: document(8),
              accounts: [ACCOUNT_THIRD],
              devices: [],
              networkAddresses: [],
              phones: [],
            },
          ],
          declaredRelationships: [],
          evidence: [],
        }),
        POLICY_VERSION,
        NOW,
      ),
  ],
];

function payerFacts(overrides: Record<string, unknown>): never | Parameters<typeof assessPayer>[0] {
  return freezeDeep({
    buyerDocument: BUYER_DOCUMENT,
    origin: {
      kind: 'external_transfer' as const,
      payerDocument: BUYER_DOCUMENT,
      senderNameMatch: nameMatch(),
    },
    relationship: { kind: 'self' as const },
    evidence: [evidence(1)],
    ...overrides,
  }) as Parameters<typeof assessPayer>[0];
}

function payerBranches(): readonly (readonly [string, () => unknown])[] {
  const other = {
    kind: 'external_transfer' as const,
    payerDocument: OTHER_DOCUMENT,
    senderNameMatch: nameMatch(),
  };
  const branches: readonly (readonly [string, Record<string, unknown>])[] = [
    ['плательщик — сам покупатель', {}],
    ['плательщик — свой же остаток', { origin: { kind: 'internal_balance', accountHolder: BUYER_DOCUMENT } }],
    ['заявлено «сам», ключи разные', { origin: other, relationship: { kind: 'self' } }],
    ['посредник', { origin: other, relationship: { kind: 'intermediary' } }],
    ['обменник', { origin: other, relationship: { kind: 'currency_exchange' } }],
    ['юрфирма', { origin: other, relationship: { kind: 'law_firm' } }],
    ['несвязанное третье лицо', { origin: other, relationship: { kind: 'unrelated_third_party' } }],
    ['отношения не заявлены', { origin: other, relationship: { kind: 'unknown' } }],
    [
      'родство без подтверждённого документа',
      {
        origin: other,
        relationship: {
          kind: 'spouse',
          proof: { document: evidence(2, 'kinship_document'), verified: false },
          payerKyc: 'complete',
        },
      },
    ],
    [
      'юрлицо с долей ниже порога',
      {
        origin: other,
        relationship: {
          kind: 'controlled_legal_entity',
          proof: { document: evidence(3, 'ownership_document'), ownershipBp: 100, verified: true },
          payerKyc: 'complete',
        },
      },
    ],
    [
      'юрлицо под контролем покупателя',
      {
        origin: other,
        relationship: {
          kind: 'controlled_legal_entity',
          proof: { document: evidence(3, 'ownership_document'), ownershipBp: 10_000, verified: true },
          payerKyc: 'complete',
        },
      },
    ],
  ];
  return branches.map(([name, overrides]) => [
    `детектор плательщика: ${name}`,
    () => assessPayer(payerFacts(overrides), POLICY_VERSION, NOW),
  ]);
}

function priceBranches(): readonly (readonly [string, () => unknown])[] {
  const base = {
    contractPrice: money('GEL', 24_000_000n),
    platformAmount: money('GEL', 24_000_000n),
    differentAmountRequested: false,
    evidence: [evidence(1, 'contract')],
  };
  const branches: readonly (readonly [string, Record<string, unknown>])[] = [
    ['сумма совпала', {}],
    ['просят указать другую сумму', { differentAmountRequested: true }],
    ['договора нет', { contractPrice: null }],
    ['валюты не сравнимы', { platformAmount: money('USD', 24_000_000n) }],
    ['сумма разошлась', { platformAmount: money('GEL', 25_000_000n) }],
  ];
  return branches.map(([name, overrides]) => [
    `детектор цены: ${name}`,
    () =>
      assessPrice(
        freezeDeep({ ...base, ...overrides }) as Parameters<typeof assessPrice>[0],
        POLICY_VERSION,
        POLICY.price,
        NOW,
      ),
  ]);
}

function refundBranches(): readonly (readonly [string, () => unknown])[] {
  const base = {
    sourceAccount: ACCOUNT_SOURCE,
    sourceHolder: BUYER_DOCUMENT,
    requestedAccount: ACCOUNT_SOURCE,
    requestedHolder: BUYER_DOCUMENT,
    sanctionsFrozen: false,
    evidence: [evidence(1)],
  };
  const branches: readonly (readonly [string, Record<string, unknown>])[] = [
    ['возврат на счёт-источник', {}],
    ['санкционная заморозка', { sanctionsFrozen: true }],
    ['счёт-источник неизвестен', { sourceAccount: null }],
    ['запрошен чужой счёт', { requestedAccount: ACCOUNT_THIRD }],
  ];
  return branches.map(([name, overrides]) => [
    `детектор возврата: ${name}`,
    () =>
      assessRefundDestination(
        freezeDeep({ ...base, ...overrides }) as Parameters<typeof assessRefundDestination>[0],
        POLICY_VERSION,
        NOW,
      ),
  ]);
}

function flippingBranches(): readonly (readonly [string, () => unknown])[] {
  const transfer = (minor: bigint) =>
    freezeDeep({
      transferId: 't-1',
      cadastralCode: 'code-1',
      registeredAt: (NOW - 10 * DAY_MS) as typeof NOW,
      price: money('GEL', minor),
    });
  const branches: readonly (readonly [string, readonly unknown[]])[] = [
    ['переходов нет', []],
    ['переход без скачка цены', [transfer(24_000_000n)]],
    ['переход со скачком цены', [transfer(10_000_000n)]],
  ];
  return branches.map(([name, priorTransfers]) => [
    `детектор перепродажи: ${name}`,
    () =>
      assessFlipping(
        freezeDeep({
          cadastralCode: 'code-1',
          currentPrice: money('GEL', 24_000_000n),
          priorTransfers,
          evidence: [],
        }) as Parameters<typeof assessFlipping>[0],
        POLICY_VERSION,
        POLICY.flipping,
        NOW,
      ),
  ]);
}

function counterpartyBranches(): readonly (readonly [string, () => unknown])[] {
  const participations = (recipient: typeof BUYER_DOCUMENT) => [
    { partyId: 'p', role: 'payer' as const, document: BUYER_DOCUMENT },
    { partyId: 'r', role: 'recipient' as const, document: recipient },
  ];
  const branches: readonly (readonly [string, Record<string, unknown>])[] = [
    ['стороны различны', { participations: participations(document(9)) }],
    ['одно лицо по обе стороны', { participations: participations(BUYER_DOCUMENT) }],
    [
      'связанные лица по обе стороны',
      {
        participations: participations(document(9)),
        relation: { kind: 'related', relation: 'spouse', proof: evidence(4, 'kinship_document') },
      },
    ],
  ];
  return branches.map(([name, overrides]) => [
    `детектор сторон сделки: ${name}`,
    () =>
      assessCounterparty(
        freezeDeep({
          participations: participations(document(9)),
          relation: { kind: 'unrelated' as const },
          nameMatch: null,
          evidence: [],
          ...overrides,
        }) as Parameters<typeof assessCounterparty>[0],
        POLICY_VERSION,
        NOW,
      ),
  ]);
}

function screeningBranches(): readonly (readonly [string, () => unknown])[] {
  const withCandidates = (
    candidates: readonly unknown[],
    whitelist: readonly unknown[] = [],
  ): Parameters<typeof decideSanctions>[0] =>
    freezeDeep({
      subjectRef: 'party-1',
      subjectNames: BUYER_NAMES,
      subjectNationalities: [],
      response: {
        kind: 'completed' as const,
        candidates,
        providerReference: 'provider-ref-1',
        rawResponseRef: 'raw-1',
        screenedAt: NOW,
      },
      whitelist,
      evidence: [evidence(1)],
    }) as Parameters<typeof decideSanctions>[0];
  const weak = { ...candidate, providerScoreBp: 10 };
  const strongId = { ...candidate, matchedFields: ['name' as const, 'document_number' as const] };
  const entry = freezeDeep({
    subjectRef: 'party-1',
    listSource: 'us_ofac' as const,
    listEntryId: 'entry-1',
    listEntryVersion: 'v1',
    adjudicatedBy: 'analyst-1',
    adjudicatedAt: NOW,
    expiresAt: (NOW + POLICY.sanctions.whitelistTtl) as typeof NOW,
    rationaleRef: 'rationale-1',
    policyVersionId: POLICY.version,
  });
  return [
    ['санкции: кандидатов нет', () => decideSanctions(withCandidates([]), POLICY, NOW)],
    ['санкции: балл ниже порога', () => decideSanctions(withCandidates([weak]), POLICY, NOW)],
    ['санкции: подтверждённое совпадение', () => decideSanctions(withCandidates([strongId]), POLICY, NOW)],
    ['санкции: кандидат погашен белым списком', () => decideSanctions(withCandidates([candidate], [entry]), POLICY, NOW)],
    [
      'санкции: разбор признал совпадение',
      () => adjudicateSanctions(possibleMatch(), 'true_match', analyst, 'rationale-1', POLICY, NOW),
    ],
  ];
}

function beneficiaryBranches(): readonly (readonly [string, () => unknown])[] {
  const georgianOnly = freezeDeep([
    {
      alphabet: 'georgian' as const,
      given: 'საბო',
      family: 'თითი',
      source: 'bank_account_holder' as const,
      evidenceWeightBp: 10_000,
    },
  ]);
  const branches: readonly (readonly [string, Record<string, unknown>])[] = [
    ['имя сошлось, владение не доказано', {}],
    ['владение доказано', { ownershipEvidence: evidence(5, 'test_transfer') }],
    ['имя владельца счёта расходится', { holderNames: OTHER_NAMES }],
    ['латинской формы нет', { holderNames: georgianOnly }],
  ];
  return branches.map(([name, overrides]) => [
    `сверка владельца счёта: ${name}`,
    () =>
      verifyBeneficiaryHolder(
        PARTICIPATION,
        freezeDeep({ ...requisites, ...overrides }) as typeof requisites,
        freezeDeep(profile()),
        POLICY,
        NOW,
      ),
  ]);
}

function ownerBranches(): readonly (readonly [string, () => unknown])[] {
  return (['matched', 'mismatched', 'absent'] as const).map((match) => [
    `сверка собственника: ${match}`,
    () => reconcileOwner(match, nameMatch()),
  ]);
}

function concentrationBranches(): readonly (readonly [string, () => unknown])[] {
  const turnover = (ru: bigint) =>
    freezeDeep({
      year: 2026,
      month: 9,
      currency: 'GEL' as const,
      totalMinor: 100_000_000n,
      byCountry: [{ country: RU, minor: ru }],
    });
  return [
    ['концентрация: в пределах лимитов', () => evaluateConcentration(turnover(1_000_000n), POLICY.concentration)],
    ['концентрация: лимит превышен', () => evaluateConcentration(turnover(90_000_000n), POLICY.concentration)],
  ];
}

/** Конверт `Result` принадлежит домену; здесь смотрим на то, что внутри. */
function payload(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'ok' in value) {
    const result = value as { ok: boolean; value?: unknown; error?: unknown };
    return result.ok ? result.value : result.error;
  }
  return value;
}

describe('значения, отданные наружу, неизменяемы целиком', () => {
  for (const [name, build] of [...CASES, ...BRANCH_CASES]) {
    it(name, () => {
      // Строкой, а не массивом: отчёт о падении обязан назвать все пути сразу.
      expect(mutablePaths(payload(build()), name).join(' | ')).toBe('');
    });
  }

  it('проверка видит незамороженный узел в глубине, а не только корень', () => {
    const nested = Object.freeze({ outer: Object.freeze({ inner: ['живой массив'] }) });
    expect(mutablePaths(nested, 'проба').join(' | ')).toBe('проба.outer.inner');
  });
});
