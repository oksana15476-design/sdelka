import {
  type Anchor,
  type AuditActor,
  type AuditChain,
  type AuditInstant,
  type AuditRecord,
  type PolicyRef,
  type RawSourceKind,
  type RawSourceRef,
  type TimestampToken,
  appendRecord,
  auditActor,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
  rawSourceRef,
  sha256Hex,
} from '../../src/index';

/**
 * Фикстуры.
 *
 * Ни одна строка здесь не изображает настоящие персональные данные: отпечатки —
 * синтетические шестнадцатеричные последовательности вида `0000…07`, ссылки на
 * хранилище — технические пути, идентификаторы — порядковые. Дисциплина та же,
 * что в `compliance/test/support/fixtures.ts`.
 */
export const T0: AuditInstant = auditInstant(Date.UTC(2026, 8, 3, 10, 0, 0));

/** Момент через `minutes` минут после начала. Время в цепочке не убывает. */
export function at(minutes: number): AuditInstant {
  return auditInstant(T0 + minutes * 60_000);
}

/** Синтетический отпечаток: номер по порядку, дополненный нулями до 64 знаков. */
export function fp(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

export const OPERATOR: AuditActor = auditActor('operator-1', 'operator', 'run_screening');
export const APPROVER: AuditActor = auditActor('approver-1', 'approver', 'approve_payout');
export const ANALYST: AuditActor = auditActor(
  'analyst-1',
  'compliance_analyst',
  'adjudicate_screening',
);
export const CLIENT: AuditActor = auditActor('party-2', 'client', null);
export const SYSTEM: AuditActor = auditActor('system', 'system', null);
export const ORACLE: AuditActor = auditActor('oracle-registry', 'oracle', null);

export const COMPLIANCE_POLICY: PolicyRef = policyRef('compliance/2026-09-03.1');
export const LEGAL_POLICY: PolicyRef = policyRef('legal/2026-08-01.2');
export const PAYOUT_POLICY: PolicyRef = policyRef('payout/2026-09-01.1');

export const DEAL = auditRef('deal', 'deal-1');
export const TRANCHE = auditRef('tranche', 'tranche-1');
export const PAYOUT = auditRef('payout', 'payout-1');
export const SELLER = auditRef('party', 'party-3');

export const BENEFICIARY = auditFingerprint('account', fp(0x0a));

export function source(
  seed: number,
  sourceKind: RawSourceKind = 'registry_extract',
  provider = 'registry',
): RawSourceRef {
  return rawSourceRef({
    sourceKind,
    storageRef: `documents/2026/09/03/${seed.toString().padStart(4, '0')}`,
    mediaType: 'application/json',
    byteLength: 128 + seed,
    digest: fp(0x100 + seed),
    receivedAt: at(seed),
    provider,
  });
}

export const CHAIN_ID = 'chain:deal-1';

export function timestampToken(covered: AuditRecord): TimestampToken {
  return Object.freeze({
    provider: 'tsa-independent',
    issuedAt: at(70),
    digest: covered.recordHash,
    token: 'MIIB+base64+opaque==',
  });
}

export function anchorAt(record: AuditRecord, minutes: number): Anchor {
  return Object.freeze({
    chainId: record.chainId,
    seq: record.seq,
    headHash: record.recordHash,
    anchoredAt: at(minutes),
    provider: 'anchor-daily',
    proof: 'anchor+receipt+opaque==',
  });
}

/** Пустая цепочка с одним генезисом — основа большинства тестов. */
export function newChain(chainId: string = CHAIN_ID): AuditChain {
  return genesisChain(chainId, T0, SYSTEM);
}

/**
 * Цепочка одной сделки, доведённой до выплаты: акт получателя об условии,
 * решение комплаенса, пакет доказательств, наблюдение оракула, поручение,
 * метка времени, результат, исправление. Ровно то, что аудитор обязан суметь
 * восстановить через год (`ROADMAP.md` И7.2).
 */
export function dossierChain(): AuditChain {
  let chain = newChain();

  chain = appendRecord(chain, {
    recordId: 'rec-act',
    recordedAt: at(1),
    actor: CLIENT,
    subject: TRANCHE,
    related: [DEAL, SELLER],
    body: {
      kind: 'condition_act_recorded',
      conditionType: 'registration_transfer',
      actorSide: 'recipient',
      act: source(1, 'condition_act', 'cabinet'),
      policy: LEGAL_POLICY,
    },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-decision',
    recordedAt: at(2),
    actor: ANALYST,
    subject: TRANCHE,
    related: [DEAL, SELLER],
    body: {
      kind: 'decision_made',
      outcomeKey: 'clear',
      policy: COMPLIANCE_POLICY,
      reasonKeys: ['screening.no_match'],
      evidence: [source(2, 'screening_response', 'screening')],
    },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-evidence',
    recordedAt: at(3),
    actor: ORACLE,
    subject: TRANCHE,
    related: [DEAL],
    body: { kind: 'evidence_attached', evidence: source(3, 'registry_extract', 'registry') },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-transition',
    recordedAt: at(4),
    actor: SYSTEM,
    subject: TRANCHE,
    related: [DEAL],
    body: {
      kind: 'state_transition',
      machine: 'tranche',
      from: 'collecting',
      to: 'condition_met',
      eventKey: 'condition_established',
      failedGuards: [],
    },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-order',
    recordedAt: at(5),
    actor: APPROVER,
    subject: PAYOUT,
    related: [TRANCHE, DEAL],
    body: {
      kind: 'payout_ordered',
      idempotencyKey: 'payout-idem-1',
      amount: auditAmount('GEL', 1_250_00n),
      beneficiary: BENEFICIARY,
      policy: PAYOUT_POLICY,
      evidencePackage: [source(1, 'condition_act', 'cabinet'), source(3)],
    },
  });

  const ordered = chain.records[chain.records.length - 1];
  if (ordered === undefined) {
    throw new Error('unreachable');
  }
  chain = appendRecord(chain, {
    recordId: 'rec-stamp',
    recordedAt: at(6),
    actor: SYSTEM,
    subject: PAYOUT,
    body: {
      kind: 'timestamp_token',
      coversRecordId: ordered.recordId,
      coveredHash: ordered.recordHash,
      timestamp: timestampToken(ordered),
    },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-result',
    recordedAt: at(7),
    actor: SYSTEM,
    subject: PAYOUT,
    related: [TRANCHE],
    body: {
      kind: 'payout_result',
      outcome: 'settled',
      response: source(4, 'payment_provider_response', 'bank'),
      reasonKey: null,
    },
  });

  chain = appendRecord(chain, {
    recordId: 'rec-fix',
    recordedAt: at(8),
    actor: OPERATOR,
    subject: TRANCHE,
    related: [DEAL],
    body: {
      kind: 'correction',
      correctsRecordId: 'rec-evidence',
      reasonKey: 'evidence.provider_misattributed',
      basis: source(8, 'operator_note', 'sdelka.console'),
      attributes: { provider: 'registry-regional' },
    },
  });

  return chain;
}

/* ------------------------------------------------------------------------- */
/* Ход противника                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Порча цепочки. Живёт только в тестах: в самом пакете нет ни одной функции,
 * способной изменить запись, поэтому подделку приходится собирать вручную —
 * именно так, как это сделал бы тот, кто добрался до базы.
 */
export function replaceRecord(
  chain: AuditChain,
  index: number,
  patch: (record: AuditRecord) => AuditRecord,
): AuditChain {
  const records = chain.records.map((record, position) =>
    position === index ? patch(record) : record,
  );
  return { chainId: chain.chainId, records };
}

export function dropRecord(chain: AuditChain, index: number): AuditChain {
  return {
    chainId: chain.chainId,
    records: chain.records.filter((_, position) => position !== index),
  };
}

export function duplicateRecord(chain: AuditChain, index: number): AuditChain {
  const records: AuditRecord[] = [];
  chain.records.forEach((record, position) => {
    records.push(record);
    if (position === index) {
      records.push(record);
    }
  });
  return { chainId: chain.chainId, records };
}

/** Подменённый отпечаток: та же форма, другое значение. */
export const FOREIGN_HASH = sha256Hex(fp(0xdead));
