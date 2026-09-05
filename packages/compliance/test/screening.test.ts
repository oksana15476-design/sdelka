import { type Instant, instant } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  type SanctionsCandidate,
  type SanctionsDecisionInput,
  type SanctionsProviderResponse,
  type WhitelistEntry,
  ANALYST_ROLE,
  actor,
  adjudicateSanctions,
  authorize,
  decideSanctions,
  hasStrongIdentifier,
  sanctionsToDetectorOutcome,
} from '../src/index';
import { BUYER_NAMES, evidence, GE, IL, NOW, POLICY, latinName } from './support/fixtures';

const analyst = authorize(actor('analyst-1', ANALYST_ROLE), 'adjudicate_screening');

function candidate(overrides: Partial<SanctionsCandidate> = {}): SanctionsCandidate {
  return {
    listSource: 'us_ofac',
    listEntryId: 'entry-1',
    listEntryVersion: 'v1',
    entryType: 'person',
    matchedFields: ['name'],
    providerScoreBp: 9_000,
    programmes: ['PROGRAMME-1'],
    listNames: null,
    ...overrides,
  };
}

function completed(candidates: readonly SanctionsCandidate[]): SanctionsProviderResponse {
  return {
    kind: 'completed',
    candidates,
    providerReference: 'provider-ref-1',
    rawResponseRef: 'raw-1',
    screenedAt: NOW,
  };
}

function decide(overrides: Partial<SanctionsDecisionInput> = {}) {
  return decideSanctions(
    {
      subjectRef: 'party-1',
      subjectNames: BUYER_NAMES,
      subjectNationalities: [IL],
      response: completed([]),
      whitelist: [],
      evidence: [evidence(1)],
      ...overrides,
    },
    POLICY,
    NOW,
  );
}

describe('санкционная политика строже грузинского права', () => {
  it('оговорка о приговоре грузинского суда выключена типом политики', () => {
    expect(POLICY.sanctions.georgianCourtJudgmentCarveOut).toBe('disapplied');
  });

  it('применяются перечни США, ЕС и Великобритании', () => {
    expect([...POLICY.sanctions.lists]).toEqual(['us_ofac', 'eu_consolidated', 'uk_ofsi']);
  });

  it('гражданство Грузии исход не смягчает и отмечается отдельной причиной', () => {
    const result = decide({
      subjectNationalities: [GE],
      response: completed([candidate()]),
    });
    expect(result.outcome).toBe('possible_match');
    expect(result.reasons).toContain('compliance.sanctions.georgian_carve_out_disapplied');
  });
});

describe('решение по кандидатам', () => {
  it('нет кандидатов — чисто', () => {
    const result = decide();
    expect(result.outcome).toBe('clear');
    expect(sanctionsToDetectorOutcome(result.outcome)).toBe('clear');
  });

  it('совпадение по сильному идентификатору — терминальный отказ', () => {
    const result = decide({
      response: completed([candidate({ matchedFields: ['name', 'document_number'] })]),
    });
    expect(result.outcome).toBe('confirmed_match');
    expect(sanctionsToDetectorOutcome(result.outcome)).toBe('block');
  });

  it('совпадение только по имени сильным не считается', () => {
    expect(hasStrongIdentifier(['name', 'date_of_birth'])).toBe(false);
    expect(hasStrongIdentifier(['national_id'])).toBe(true);
    const result = decide({ response: completed([candidate()]) });
    expect(result.outcome).toBe('possible_match');
    // Fail-closed: возможное совпадение удерживает средства, а не пропускает.
    expect(sanctionsToDetectorOutcome(result.outcome)).toBe('hold');
  });

  it('кандидат ниже порога отсеивается', () => {
    const result = decide({ response: completed([candidate({ providerScoreBp: 1_000 })]) });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.sanctions.below_threshold');
  });

  it('балл провайдера ровно на пороге кандидата удерживает', () => {
    // У скрининга дорог пропуск: равенство порогу читается как его достижение,
    // и кандидат уходит аналитику, а не отсеивается.
    const atThreshold = POLICY.sanctions.candidateThreshold.valueBp;
    expect(decide({ response: completed([candidate({ providerScoreBp: atThreshold })]) }).outcome).toBe(
      'possible_match',
    );
    expect(
      decide({ response: completed([candidate({ providerScoreBp: atThreshold - 1 })]) }).outcome,
    ).toBe('clear');
  });

  it('собственный балл ровно на пороге по имени тоже удерживает', () => {
    // Балл провайдера ниже его порога, сильного идентификатора нет: решает
    // только собственное сравнение имён, и его граница — та же включающая.
    const strict = {
      ...POLICY,
      nameThresholds: { ...POLICY.nameThresholds, screening: { valueBp: 10_000, rationaleDocRef: 'docs' } },
    };
    const request = {
      subjectRef: 'party-1',
      subjectNames: BUYER_NAMES,
      subjectNationalities: [IL],
      response: completed([
        candidate({ providerScoreBp: 100, listNames: [latinName('Sabo', 'Tikato')] }),
      ]),
      whitelist: [],
      evidence: [evidence(1)],
    };
    // Формы совпадают буквально — собственный балл ровно 10 000, то есть порог.
    expect(decideSanctions(request, strict, NOW).outcome).toBe('possible_match');
  });

  it('чистый скрининг не несёт причины о грузинской оговорке', () => {
    // Оговорка отмечается для банка-партнёра там, где кандидат остался. Без
    // кандидатов отмечать нечего, а лишняя причина в чистом решении читается
    // как «что-то нашли».
    const result = decide({ subjectNationalities: [GE], response: completed([]) });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).not.toContain('compliance.sanctions.georgian_carve_out_disapplied');
  });

  it('собственный балл по формам перечня поднимает кандидата при низком балле провайдера', () => {
    const result = decide({
      response: completed([
        candidate({ providerScoreBp: 100, listNames: [latinName('Sabo', 'Tikato')] }),
      ]),
    });
    expect(result.outcome).toBe('possible_match');
  });

  it('перечень вне политики не применяется', () => {
    const foreign = { ...candidate(), listSource: 'other' as unknown as SanctionsCandidate['listSource'] };
    const result = decide({ response: completed([foreign]) });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.sanctions.list_not_covered');
  });

  it('недоступность провайдера никогда не читается как «чисто»', () => {
    const result = decide({ response: { kind: 'unavailable', providerReference: null } });
    expect(result.outcome).toBe('unavailable');
    expect(sanctionsToDetectorOutcome(result.outcome)).toBe('hold');
    expect(result.reasons).toContain('compliance.sanctions.provider_unavailable');
  });

  it('решение хранит ссылку на сырой ответ источника', () => {
    const result = decide({ response: completed([candidate()]) });
    expect(result.evidence.some((item) => item.ref === 'raw-1')).toBe(true);
  });
});

describe('белый список', () => {
  function entry(overrides: Partial<WhitelistEntry> = {}): WhitelistEntry {
    return {
      subjectRef: 'party-1',
      listSource: 'us_ofac',
      listEntryId: 'entry-1',
      listEntryVersion: 'v1',
      adjudicatedBy: 'analyst-1',
      adjudicatedAt: NOW,
      expiresAt: instant(NOW + 1000) as Instant,
      rationaleRef: 'rationale-1',
      policyVersionId: POLICY.version,
      ...overrides,
    };
  }

  it('действующая запись гасит кандидата', () => {
    const result = decide({ response: completed([candidate()]), whitelist: [entry()] });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).toContain('compliance.sanctions.whitelist_suppressed');
  });

  it('истёкшая запись не гасит', () => {
    const result = decide({
      response: completed([candidate()]),
      whitelist: [entry({ expiresAt: instant(NOW - 1) as Instant })],
    });
    expect(result.outcome).toBe('possible_match');
    expect(result.reasons).toContain('compliance.sanctions.whitelist_expired');
  });

  it('запись, истекающая ровно сейчас, уже не гасит', () => {
    // Срок жизни разобранного ложного хита истекает **в** названный момент, а не
    // после него: иначе на самой границе кандидат исчезает без разбора.
    const result = decide({
      response: completed([candidate()]),
      whitelist: [entry({ expiresAt: NOW })],
    });
    expect(result.outcome).toBe('possible_match');
    expect(result.reasons).toContain('compliance.sanctions.whitelist_expired');
  });

  it('запись, истекающая через миллисекунду, ещё гасит', () => {
    const result = decide({
      response: completed([candidate()]),
      whitelist: [entry({ expiresAt: instant(NOW + 1) as Instant })],
    });
    expect(result.outcome).toBe('clear');
  });

  it('запись к другой версии записи перечня не гасит', () => {
    const result = decide({
      response: completed([candidate({ listEntryVersion: 'v2' })]),
      whitelist: [entry({ listEntryVersion: 'v1' })],
    });
    expect(result.outcome).toBe('possible_match');
    expect(result.reasons).toContain('compliance.sanctions.whitelist_stale_entry_version');
  });

  it('белый список не покрывает совпадение по сильному идентификатору', () => {
    const result = decide({
      response: completed([candidate({ matchedFields: ['document_number'] })]),
      whitelist: [entry()],
    });
    expect(result.outcome).toBe('confirmed_match');
  });
});

describe('разбор аналитиком', () => {
  it('ложное срабатывание закрывает кандидата и порождает запись белого списка', () => {
    const possible = decide({ response: completed([candidate()]) });
    if (possible.outcome !== 'possible_match') throw new Error('ожидалось possible_match');
    const result = adjudicateSanctions(possible, 'false_positive', analyst, 'rationale-1', POLICY, NOW);
    expect(result.decision.outcome).toBe('clear');
    expect(result.whitelistEntries).toHaveLength(1);
    expect(result.whitelistEntries[0]?.adjudicatedBy).toBe('analyst-1');
    expect(result.whitelistEntries[0]?.rationaleRef).toBe('rationale-1');
    expect(result.whitelistEntries[0]?.expiresAt).toBe(NOW + POLICY.sanctions.whitelistTtl);
  });

  it('подтверждение аналитиком даёт терминальный отказ без записи белого списка', () => {
    const possible = decide({ response: completed([candidate()]) });
    if (possible.outcome !== 'possible_match') throw new Error('ожидалось possible_match');
    const result = adjudicateSanctions(possible, 'true_match', analyst, 'rationale-2', POLICY, NOW);
    expect(result.decision.outcome).toBe('confirmed_match');
    expect(result.whitelistEntries).toHaveLength(0);
  });

  it('подтверждённое совпадение на разбор не передаётся', () => {
    const confirmed = decide({
      response: completed([candidate({ matchedFields: ['document_number'] })]),
    });
    if (confirmed.outcome !== 'confirmed_match') throw new Error('ожидалось confirmed_match');
    // Терминальный отказ не является предметом усмотрения оператора:
    // @ts-expect-error разбор принимает только possible_match
    adjudicateSanctions(confirmed, 'false_positive', analyst, 'r', POLICY, NOW);
  });
});
