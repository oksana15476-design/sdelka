import { type AnchorCoverage, anchorCoverage } from './anchor';
import type { AuditChain } from './chain';
import { correctionsOf } from './corrections';
import type { AuditInstant } from './instant';
import type { Anchor, TimestampToken } from './ports';
import type { AuditActor, AuditRecord, PolicyRef } from './record';
import type { RawSourceRef } from './raw-source';
import { type AuditRef, sameRef } from './values';
import { type ChainVerification, verifyChain } from './verify';

/**
 * Досье по выплате — критерий приёмки истории И7.2 одной функцией.
 *
 * «По любой выплате восстанавливается: на основании какого документа, кем и
 * когда принято решение, по каким правилам, и что запись не правилась задним
 * числом» (`CORE.md` Ф11). Здесь это четыре поля: `evidence`, `decisions`,
 * `policies`, `integrity` вместе с `anchorCoverage` и `independentTime`.
 *
 * Досье выдаётся **всегда**, даже по порванной цепочке: аудитору нужны и
 * материалы, и правда о том, что с ними не так. Молчаливый отказ здесь был бы
 * худшим из ответов.
 */
export interface PayoutDecisionTrace {
  readonly recordId: string;
  readonly recordedAt: AuditInstant;
  readonly actor: AuditActor;
  readonly policy: PolicyRef;
  readonly outcomeKey: string;
}

export interface PayoutDossier {
  readonly subject: AuditRef;
  readonly records: readonly AuditRecord[];
  /** На основании какого документа. Сами байты поднимаются по `storageRef`. */
  readonly evidence: readonly RawSourceRef[];
  /** Кем и когда. */
  readonly decisions: readonly PayoutDecisionTrace[];
  /** По каким правилам. */
  readonly policies: readonly PolicyRef[];
  readonly ordered: AuditRecord | null;
  readonly result: AuditRecord | null;
  /** Метки независимого поставщика, покрывающие записи досье. */
  readonly independentTime: readonly TimestampToken[];
  readonly corrections: readonly AuditRecord[];
  /** Не правилась ли запись задним числом — изнутри цепочки. */
  readonly integrity: ChainVerification;
  /** …и снаружи: цепочка целиком могла быть переписана, это ловит только якорь. */
  readonly anchors: AnchorCoverage;
}

function bodyEvidence(record: AuditRecord): readonly RawSourceRef[] {
  const body = record.body;
  switch (body.kind) {
    case 'decision_made':
      return body.evidence;
    case 'payout_ordered':
      return body.evidencePackage;
    case 'payout_result':
      return body.response === null ? [] : [body.response];
    case 'condition_act_recorded':
      return [body.act];
    case 'evidence_attached':
      return [body.evidence];
    case 'correction':
      // Основание исправления — такой же материал досье, как основание решения:
      // аудитор обязан увидеть, на чём стоит пометка, а не только её текст-ключ.
      return [body.basis];
    default:
      return [];
  }
}

function bodyPolicy(record: AuditRecord): PolicyRef | null {
  const body = record.body;
  switch (body.kind) {
    case 'decision_made':
    case 'payout_ordered':
    case 'condition_act_recorded':
    case 'beneficiary_changed':
      return body.policy;
    default:
      return null;
  }
}

function touches(record: AuditRecord, refs: readonly AuditRef[]): boolean {
  return refs.some(
    (ref) => sameRef(record.subject, ref) || record.related.some((item) => sameRef(item, ref)),
  );
}

/**
 * Сбор идёт в две волны. Первая — записи, где выплата стоит субъектом или
 * связанной сущностью. Вторая — записи по сущностям, которые первая волна
 * назвала связанными: транш и сделка. Именно там лежит акт получателя об
 * условии, без которого «на основании какого документа» остаётся без ответа,
 * а сама выплата на него не ссылается — акта ещё не существовало, когда транш
 * только принимал средства.
 */
export function reconstructPayout(
  chain: AuditChain,
  anchors: readonly Anchor[],
  payout: AuditRef,
): PayoutDossier {
  const direct = chain.records.filter((record) => touches(record, [payout]));
  const relatedRefs: AuditRef[] = [];
  for (const record of direct) {
    for (const ref of [record.subject, ...record.related]) {
      if (!sameRef(ref, payout) && !relatedRefs.some((item) => sameRef(item, ref))) {
        relatedRefs.push(ref);
      }
    }
  }
  const collected = new Map<string, AuditRecord>();
  for (const record of chain.records) {
    if (touches(record, [payout]) || touches(record, relatedRefs)) {
      collected.set(record.recordId, record);
    }
  }

  const corrections: AuditRecord[] = [];
  for (const recordId of [...collected.keys()]) {
    for (const correction of correctionsOf(chain, recordId)) {
      corrections.push(correction);
      collected.set(correction.recordId, correction);
    }
  }

  const independentTime: TimestampToken[] = [];
  for (const record of chain.records) {
    if (record.body.kind === 'timestamp_token' && collected.has(record.body.coversRecordId)) {
      independentTime.push(record.body.timestamp);
      collected.set(record.recordId, record);
    }
  }

  const records = chain.records.filter((record) => collected.has(record.recordId));

  const evidence: RawSourceRef[] = [];
  const decisions: PayoutDecisionTrace[] = [];
  const policies: PolicyRef[] = [];
  let ordered: AuditRecord | null = null;
  let result: AuditRecord | null = null;

  for (const record of records) {
    for (const item of bodyEvidence(record)) {
      if (!evidence.some((existing) => existing.digest === item.digest)) {
        evidence.push(item);
      }
    }
    const policy = bodyPolicy(record);
    if (policy !== null && !policies.includes(policy)) {
      policies.push(policy);
    }
    if (record.body.kind === 'decision_made') {
      decisions.push(
        Object.freeze({
          recordId: record.recordId,
          recordedAt: record.recordedAt,
          actor: record.actor,
          policy: record.body.policy,
          outcomeKey: record.body.outcomeKey,
        }),
      );
    }
    if (record.body.kind === 'payout_ordered' && sameRef(record.subject, payout)) {
      ordered = record;
    }
    if (record.body.kind === 'payout_result' && sameRef(record.subject, payout)) {
      result = record;
    }
  }

  return Object.freeze({
    subject: payout,
    records: Object.freeze(records),
    evidence: Object.freeze(evidence),
    decisions: Object.freeze(decisions),
    policies: Object.freeze(policies),
    ordered,
    result,
    independentTime: Object.freeze(independentTime),
    corrections: Object.freeze(corrections),
    integrity: verifyChain(chain),
    anchors: anchorCoverage(chain, anchors),
  });
}
