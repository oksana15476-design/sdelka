import type { Instant } from '@sdelka/domain';
import type { Decision, EvidenceKind, PolicyVersionId } from './decision';
import type { ReasonKey } from './keys';
import type { NameFeatures, NameMatch, NameMatchDegree } from './names';
import type { NameDigest } from './pii';

/**
 * Журнальные проекции.
 *
 * Решение само по себе персональных данных не содержит: в нём только исход,
 * версия политики, ключи причин и ссылки на доказательства. Опасное место одно —
 * `NameMatch`: ради объяснимости он несёт паспортные формы обоих имён, и это
 * полноценные персональные данные. В журнал уходит проекция без них.
 */
export interface LogSafeDecision {
  readonly outcome: string;
  readonly policyVersionId: PolicyVersionId;
  readonly decidedAt: Instant;
  readonly reasons: readonly ReasonKey[];
  readonly evidence: readonly { readonly kind: EvidenceKind; readonly ref: string }[];
}

export function logSafeDecision<O extends string>(value: Decision<O>): LogSafeDecision {
  return Object.freeze({
    outcome: value.outcome,
    policyVersionId: value.policyVersionId,
    decidedAt: value.decidedAt,
    reasons: value.reasons,
    evidence: Object.freeze(
      value.evidence.map((item) => Object.freeze({ kind: item.kind, ref: item.ref })),
    ),
  });
}

export interface LogSafeNameMatch {
  readonly degree: NameMatchDegree;
  readonly scoreBp: number;
  readonly features: NameFeatures;
  readonly left: NameDigest | null;
  readonly right: NameDigest | null;
  /** Сколько грузинских написаний допускает совпавшая форма — число, не форма. */
  readonly georgianSpellingCount: number;
  readonly ambiguousGraphemes: readonly string[];
  readonly reasons: readonly ReasonKey[];
}

export function logSafeNameMatch(match: NameMatch): LogSafeNameMatch {
  return Object.freeze({
    degree: match.degree,
    scoreBp: match.scoreBp,
    features: match.features,
    left: match.best?.left ?? null,
    right: match.best?.right ?? null,
    georgianSpellingCount: match.georgianSpellingCount,
    ambiguousGraphemes: Object.freeze(match.ambiguities.map((item) => item.grapheme)),
    reasons: match.reasons,
  });
}
