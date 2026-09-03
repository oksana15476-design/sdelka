import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from './decision';
import type { CountryCode } from './identity';
import { type ReasonKey, REASON_KEYS } from './keys';
import { type NameObservations, compareNames } from './names';
import type { CompliancePolicy, SanctionsListSource } from './policy';
import type { Authority } from './roles';

/**
 * Санкционный скрининг: **порт к провайдеру плюс логика решения**. Интеграции
 * здесь нет и быть не должно — провайдер за портом, решение чистое.
 *
 * Политика строже грузинского права: перечни США, ЕС и Великобритании
 * применяются буквально, грузинская оговорка о приговоре суда в нашей политике
 * не действует (`PRODUCT.md` §10, `CCO-compliance.md`). Оговорка выключена типом
 * политики, а не значением флага — см. `SanctionsPolicy`.
 *
 * Установленное совпадение — **терминальный отказ, а не усмотрение оператора**.
 * Это выражено формой: функция разбора принимает только `SanctionsPossibleMatch`,
 * и передать ей `SanctionsConfirmedMatch` компилятор не даст. Функции, которая
 * снимает подтверждённое совпадение, в пакете нет.
 */
export const MATCHED_FIELDS = [
  'name',
  'date_of_birth',
  'place_of_birth',
  'nationality',
  'address',
  'document_number',
  'national_id',
] as const;
export type MatchedField = (typeof MATCHED_FIELDS)[number];

/**
 * Сильные идентификаторы. Совпадение по имени сильным не считается: латинизация
 * необратима, у одной латинской формы четыре грузинских прообраза. Кандидат по
 * имени уходит аналитику под удержанием, а не в терминальный отказ.
 */
export const STRONG_IDENTIFIERS = ['document_number', 'national_id'] as const;
export type StrongIdentifier = (typeof STRONG_IDENTIFIERS)[number];

export function hasStrongIdentifier(fields: readonly MatchedField[]): boolean {
  return fields.some((field) => (STRONG_IDENTIFIERS as readonly string[]).includes(field));
}

export const SANCTIONS_ENTRY_TYPES = ['person', 'entity', 'vessel'] as const;
export type SanctionsEntryType = (typeof SANCTIONS_ENTRY_TYPES)[number];

export interface SanctionsCandidate {
  readonly listSource: SanctionsListSource;
  readonly listEntryId: string;
  /** Версия записи перечня. Белый список привязан к версии: перечень меняется. */
  readonly listEntryVersion: string;
  readonly entryType: SanctionsEntryType;
  readonly matchedFields: readonly MatchedField[];
  readonly providerScoreBp: number;
  readonly programmes: readonly string[];
  /** Формы имени из перечня, если провайдер их отдаёт. `null` — считаем по его баллу. */
  readonly listNames: NameObservations | null;
}

export interface SanctionsScreeningRequest {
  readonly subjectRef: string;
  readonly names: NameObservations;
  readonly nationalities: readonly CountryCode[];
  readonly lists: readonly SanctionsListSource[];
  readonly requestedAt: Instant;
  readonly policyVersionId: PolicyVersionId;
}

export type SanctionsProviderResponse =
  | {
      readonly kind: 'completed';
      readonly candidates: readonly SanctionsCandidate[];
      readonly providerReference: string;
      /** Ссылка на сырой ответ источника: разобранные поля суд не убедят. */
      readonly rawResponseRef: string;
      readonly screenedAt: Instant;
    }
  | {
      readonly kind: 'unavailable';
      readonly providerReference: string | null;
    };

/**
 * Порт провайдера. Единственное асинхронное место модуля; всё решение ниже —
 * чистое. Реализация живёт вне пакета: сеть, ключи и повторы — не наша логика.
 *
 * Контракт, как у платёжных адаптеров (`FUNCTIONAL.md` инвариант 14): сетевая
 * ошибка возвращает `unavailable`, а не пустой список кандидатов. «Ничего не
 * нашли» и «не смогли посмотреть» — разные ответы.
 */
export interface SanctionsScreeningPort {
  screen(request: SanctionsScreeningRequest): Promise<SanctionsProviderResponse>;
}

/* ------------------------------------------------------------------------- */
/* Белый список                                                              */
/* ------------------------------------------------------------------------- */

export interface WhitelistEntry {
  readonly subjectRef: string;
  readonly listSource: SanctionsListSource;
  readonly listEntryId: string;
  readonly listEntryVersion: string;
  readonly adjudicatedBy: string;
  readonly adjudicatedAt: Instant;
  readonly expiresAt: Instant;
  /** Ссылка на письменное обоснование. Запись без обоснования не создаётся. */
  readonly rationaleRef: string;
  readonly policyVersionId: PolicyVersionId;
}

export function whitelistCovers(
  entry: WhitelistEntry,
  subjectRef: string,
  candidate: SanctionsCandidate,
  now: Instant,
): boolean {
  return (
    entry.subjectRef === subjectRef &&
    entry.listSource === candidate.listSource &&
    entry.listEntryId === candidate.listEntryId &&
    // Версия записи изменилась — прежний разбор к ней не относится.
    entry.listEntryVersion === candidate.listEntryVersion &&
    now < entry.expiresAt
  );
}

/* ------------------------------------------------------------------------- */
/* Решение                                                                   */
/* ------------------------------------------------------------------------- */

export const SANCTIONS_OUTCOMES = [
  'clear',
  'possible_match',
  'confirmed_match',
  'unavailable',
] as const;
export type SanctionsOutcome = (typeof SANCTIONS_OUTCOMES)[number];

export interface SanctionsClear extends Decision<'clear'> {
  readonly candidates: readonly SanctionsCandidate[];
  readonly subjectRef: string;
}
export interface SanctionsPossibleMatch extends Decision<'possible_match'> {
  readonly candidates: readonly SanctionsCandidate[];
  readonly subjectRef: string;
}
export interface SanctionsConfirmedMatch extends Decision<'confirmed_match'> {
  readonly candidates: readonly SanctionsCandidate[];
  readonly subjectRef: string;
}
export interface SanctionsUnavailable extends Decision<'unavailable'> {
  readonly candidates: readonly SanctionsCandidate[];
  readonly subjectRef: string;
}

export type SanctionsDecision =
  | SanctionsClear
  | SanctionsPossibleMatch
  | SanctionsConfirmedMatch
  | SanctionsUnavailable;

/**
 * Отображение исхода скрининга на общую лестницу детекторов.
 * `unavailable` отображается в удержание, а не в «чисто»: отсутствие ответа
 * никогда не читается как «всё хорошо» (`CORE.md` Ф7, fail-closed).
 */
export function sanctionsToDetectorOutcome(outcome: SanctionsOutcome): DetectorOutcome {
  switch (outcome) {
    case 'clear':
      return 'clear';
    case 'possible_match':
      return 'hold';
    case 'confirmed_match':
      return 'block';
    case 'unavailable':
      return 'hold';
    default:
      // Данные пересекают границу процесса: нераспознанный исход читается как
      // отказ, а не как «чисто». Отказ закрытый — общее правило системы.
      return 'block';
  }
}

export interface SanctionsDecisionInput {
  readonly subjectRef: string;
  readonly subjectNames: NameObservations;
  readonly subjectNationalities: readonly CountryCode[];
  readonly response: SanctionsProviderResponse;
  readonly whitelist: readonly WhitelistEntry[];
  readonly evidence: readonly EvidenceRef[];
}

const GEORGIA: string = 'GE';

export function decideSanctions(
  input: SanctionsDecisionInput,
  policy: CompliancePolicy,
  now: Instant,
): SanctionsDecision {
  const sanctions = policy.sanctions;
  const reasons: ReasonKey[] = [];

  if (input.response.kind === 'unavailable') {
    return Object.freeze({
      ...decision<'unavailable'>(
        'unavailable',
        policy.version,
        now,
        [REASON_KEYS.sanctionsProviderUnavailable],
        input.evidence,
      ),
      candidates: Object.freeze([]),
      subjectRef: input.subjectRef,
    });
  }

  const evidence: readonly EvidenceRef[] = Object.freeze([
    ...input.evidence,
    {
      kind: 'screening_response' as const,
      ref: input.response.rawResponseRef,
      observedAt: input.response.screenedAt,
    },
  ]);

  const covered: SanctionsCandidate[] = [];
  for (const candidate of input.response.candidates) {
    if (!sanctions.lists.includes(candidate.listSource)) {
      if (!reasons.includes(REASON_KEYS.sanctionsListNotCovered)) {
        reasons.push(REASON_KEYS.sanctionsListNotCovered);
      }
      continue;
    }
    covered.push(candidate);
  }

  // Порог отсева. Наш собственный балл по имени считается там, где провайдер
  // отдал формы из перечня: у скрининга дорог пропуск, поэтому достаточно
  // превышения любого из двух порогов.
  const retained: SanctionsCandidate[] = [];
  for (const candidate of covered) {
    const providerPasses = candidate.providerScoreBp >= sanctions.candidateThreshold.valueBp;
    let ownPasses = false;
    if (candidate.listNames !== null) {
      const match = compareNames(input.subjectNames, candidate.listNames, {
        strongThresholdBp: policy.nameThresholds.screening.valueBp,
        weights: policy.nameThresholds.weights,
      });
      ownPasses = match.scoreBp >= policy.nameThresholds.screening.valueBp;
    }
    if (providerPasses || ownPasses || hasStrongIdentifier(candidate.matchedFields)) {
      retained.push(candidate);
    } else if (!reasons.includes(REASON_KEYS.sanctionsBelowThreshold)) {
      reasons.push(REASON_KEYS.sanctionsBelowThreshold);
    }
  }

  if (
    retained.length > 0 &&
    input.subjectNationalities.some((country) => (country as string) === GEORGIA)
  ) {
    // Показывается банку-партнёру: оговорка о приговоре грузинского суда у нас
    // не применяется, гражданство Грузии не смягчает исход.
    reasons.push(REASON_KEYS.sanctionsGeorgianCarveOutDisapplied);
  }

  // Подтверждённое совпадение: сильный идентификатор. Белый список его не
  // покрывает — разбор ложного срабатывания по имени не отменяет совпадения
  // по номеру документа.
  const confirmed = retained.filter((candidate) => hasStrongIdentifier(candidate.matchedFields));
  if (confirmed.length > 0) {
    return Object.freeze({
      ...decision<'confirmed_match'>(
        'confirmed_match',
        policy.version,
        now,
        [...reasons, REASON_KEYS.sanctionsConfirmedMatch],
        evidence,
      ),
      candidates: Object.freeze(confirmed),
      subjectRef: input.subjectRef,
    });
  }

  const open: SanctionsCandidate[] = [];
  for (const candidate of retained) {
    const suppressed = input.whitelist.some((entry) =>
      whitelistCovers(entry, input.subjectRef, candidate, now),
    );
    const stale = input.whitelist.some(
      (entry) =>
        entry.subjectRef === input.subjectRef &&
        entry.listSource === candidate.listSource &&
        entry.listEntryId === candidate.listEntryId &&
        !whitelistCovers(entry, input.subjectRef, candidate, now),
    );
    if (suppressed) {
      if (!reasons.includes(REASON_KEYS.sanctionsWhitelistSuppressed)) {
        reasons.push(REASON_KEYS.sanctionsWhitelistSuppressed);
      }
      continue;
    }
    if (stale) {
      const versionChanged = input.whitelist.some(
        (entry) =>
          entry.subjectRef === input.subjectRef &&
          entry.listEntryId === candidate.listEntryId &&
          entry.listEntryVersion !== candidate.listEntryVersion,
      );
      const staleReason = versionChanged
        ? REASON_KEYS.sanctionsWhitelistStaleEntryVersion
        : REASON_KEYS.sanctionsWhitelistExpired;
      if (!reasons.includes(staleReason)) reasons.push(staleReason);
    }
    open.push(candidate);
  }

  if (open.length > 0) {
    return Object.freeze({
      ...decision<'possible_match'>(
        'possible_match',
        policy.version,
        now,
        [...reasons, REASON_KEYS.sanctionsPossibleMatch],
        evidence,
      ),
      candidates: Object.freeze(open),
      subjectRef: input.subjectRef,
    });
  }

  return Object.freeze({
    ...decision<'clear'>(
      'clear',
      policy.version,
      now,
      [...reasons, REASON_KEYS.sanctionsNoCandidates],
      evidence,
    ),
    candidates: Object.freeze([]),
    subjectRef: input.subjectRef,
  });
}

/* ------------------------------------------------------------------------- */
/* Разбор аналитиком                                                         */
/* ------------------------------------------------------------------------- */

export const ADJUDICATION_VERDICTS = ['false_positive', 'true_match'] as const;
export type AdjudicationVerdict = (typeof ADJUDICATION_VERDICTS)[number];

export interface Adjudication {
  readonly decision: SanctionsClear | SanctionsConfirmedMatch;
  /** Записи белого списка, порождённые разбором. Пусто при `true_match`. */
  readonly whitelistEntries: readonly WhitelistEntry[];
}

/**
 * Разбор возможного совпадения аналитиком.
 *
 * Принимает **только** `SanctionsPossibleMatch`. Подтверждённое совпадение сюда
 * не передать: терминальный отказ не является предметом усмотрения, и это
 * ограничение проверяет компилятор, а не инструкция.
 */
export function adjudicateSanctions(
  possible: SanctionsPossibleMatch,
  verdict: AdjudicationVerdict,
  authority: Authority<'adjudicate_screening'>,
  rationaleRef: string,
  policy: CompliancePolicy,
  now: Instant,
): Adjudication {
  if (verdict === 'true_match') {
    return Object.freeze({
      decision: Object.freeze({
        ...decision<'confirmed_match'>(
          'confirmed_match',
          policy.version,
          now,
          [...possible.reasons, REASON_KEYS.sanctionsConfirmedMatch],
          possible.evidence,
        ),
        candidates: possible.candidates,
        subjectRef: possible.subjectRef,
      }),
      whitelistEntries: Object.freeze([]),
    });
  }

  const entries = possible.candidates.map((candidate) =>
    Object.freeze({
      subjectRef: possible.subjectRef,
      listSource: candidate.listSource,
      listEntryId: candidate.listEntryId,
      listEntryVersion: candidate.listEntryVersion,
      adjudicatedBy: authority.actorId,
      adjudicatedAt: now,
      expiresAt: (now + policy.sanctions.whitelistTtl) as Instant,
      rationaleRef,
      policyVersionId: policy.version,
    }),
  );

  return Object.freeze({
    decision: Object.freeze({
      ...decision<'clear'>(
        'clear',
        policy.version,
        now,
        [...possible.reasons, REASON_KEYS.sanctionsWhitelistSuppressed],
        possible.evidence,
      ),
      candidates: Object.freeze([]),
      subjectRef: possible.subjectRef,
    }),
    whitelistEntries: Object.freeze(entries),
  });
}
