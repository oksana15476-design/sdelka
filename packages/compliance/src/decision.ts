import type { Instant } from '@sdelka/domain';
import { ComplianceError, ComplianceErrorCode } from './errors';
import type { ReasonKey } from './keys';

/**
 * Решение комплаенса.
 *
 * `CORE.md` Ф11: **каждое решение хранит версию политики, действовавшую в момент
 * принятия**. Здесь это не соглашение, а поле обязательного типа: функции,
 * возвращающей исход без версии политики, в пакете не существует — собрать
 * `Decision` без `policyVersionId` не даст компилятор.
 */
export type PolicyVersionId = string & { readonly __policyVersionId: unique symbol };

/** Формат: `compliance/<год>-<месяц>-<день>.<порядковый>`, чтобы версии сортировались. */
const POLICY_VERSION_PATTERN = /^compliance\/\d{4}-\d{2}-\d{2}\.\d+$/u;

export function policyVersionId(value: string): PolicyVersionId {
  if (!POLICY_VERSION_PATTERN.test(value)) {
    throw new ComplianceError(ComplianceErrorCode.policyVersionInvalid, { value });
  }
  return value as PolicyVersionId;
}

export const EVIDENCE_KINDS = [
  'identity_document',
  'kinship_document',
  'ownership_document',
  'contract',
  'registry_extract',
  'bank_statement',
  'screening_response',
  'test_transfer',
  'operator_note',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * Ссылка на доказательство. Само доказательство лежит в хранилище документов —
 * здесь только идентификатор и метка времени источника, чтобы решение можно было
 * восстановить, а сырой ответ источника поднять отдельно.
 */
export interface EvidenceRef {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly observedAt: Instant;
}

export interface Decision<O extends string> {
  readonly outcome: O;
  readonly policyVersionId: PolicyVersionId;
  readonly decidedAt: Instant;
  readonly reasons: readonly ReasonKey[];
  readonly evidence: readonly EvidenceRef[];
}

export function decision<O extends string>(
  outcome: O,
  policy: PolicyVersionId,
  decidedAt: Instant,
  reasons: readonly ReasonKey[],
  evidence: readonly EvidenceRef[] = [],
): Decision<O> {
  return Object.freeze({
    outcome,
    policyVersionId: policy,
    decidedAt,
    reasons: Object.freeze([...reasons]),
    evidence: Object.freeze([...evidence]),
  });
}

/* ------------------------------------------------------------------------- */
/* Лестница исходов                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Единая лестница исходов детекторов. Одна на все детекторы намеренно: сводный
 * исход по сделке — это максимум, а максимум определён только на одной шкале.
 *
 * `clear`  — ничего не сработало;
 * `review` — задача в очередь разбора, операция продолжается;
 * `stop`   — операция останавливается, требуется оценка на отчёт о подозрении;
 * `hold`   — средства удерживаются и не зачисляются на сделку;
 * `block`  — операция отвергается.
 */
export const DETECTOR_OUTCOMES = ['clear', 'review', 'stop', 'hold', 'block'] as const;
export type DetectorOutcome = (typeof DETECTOR_OUTCOMES)[number];

const SEVERITY: Readonly<Record<DetectorOutcome, number>> = Object.freeze({
  clear: 0,
  review: 1,
  stop: 2,
  hold: 3,
  block: 4,
});

export function outcomeSeverity(outcome: DetectorOutcome): number {
  return SEVERITY[outcome];
}

/** Сводный исход — максимум по лестнице. Пустой набор читается как `clear`. */
export function combineOutcomes(outcomes: readonly DetectorOutcome[]): DetectorOutcome {
  let worst: DetectorOutcome = 'clear';
  for (const outcome of outcomes) {
    if (SEVERITY[outcome] > SEVERITY[worst]) worst = outcome;
  }
  return worst;
}

export type DetectorDecision = Decision<DetectorOutcome>;
