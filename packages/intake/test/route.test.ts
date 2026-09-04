import { describe, expect, it } from 'vitest';
import {
  type CandidateSignals,
  INTAKE_REASON_KEYS,
  combineRouting,
  matchIncoming,
  matchReference,
  paymentReference,
  routeByMatch,
  routeByPayer,
} from '../src/index';
import {
  NO_NAME_MATCH,
  POLICY,
  STRANGER_DOCUMENT,
  assessment,
  spouseAssessment,
  strangerAssessment,
} from './support/fixtures';

const REFERENCE = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });

function candidate(overrides: Partial<CandidateSignals> = {}): CandidateSignals {
  return {
    dealId: 'deal-1',
    trancheId: 't1',
    reference: matchReference(REFERENCE, REFERENCE, POLICY),
    amountFits: true,
    sourceAccountSeen: true,
    currencyMatches: true,
    senderName: null,
    ...overrides,
  };
}

describe('правило плательщика не пишется заново — берётся исход комплаенса', () => {
  it('платёж от самого покупателя идёт на счёт клиента без задачи', () => {
    const routing = routeByPayer(assessment());
    expect(routing.route).toBe('to_client_account');
    expect(routing.queueTask).toBeNull();
  });

  it('исключение по родству с документами и полным KYC доводит деньги до счёта клиента', () => {
    // Сегодня в домене этот путь недостижим: `g_payer_matches` сравнивает строки
    // и об исключениях не знает. `INTAKE.md` §7.1.
    const assessed = spouseAssessment();
    expect(assessed.outcome).toBe('review');
    expect(assessed.exceptionApplied).toBe('spouse');

    const routing = routeByPayer(assessed);
    expect(routing.route).toBe('to_client_account');
    expect(routing.queueTask).toBe('payer_exception');
  });

  it('платёж от постороннего не попадает на счёт клиента ни при какой сумме', () => {
    const routing = routeByPayer(strangerAssessment());
    expect(routing.route).toBe('to_suspense');
    expect(routing.queueTask).toBe('payer_hold');
    expect(routing.reasons).toContain(INTAKE_REASON_KEYS.routePayerHold);
  });

  it('посредник блокируется без исключений', () => {
    // Личность плательщика обязана отличаться: при совпадении ключа документа
    // лестница отношений не рассматривается вовсе — плательщик и есть покупатель.
    const routing = routeByPayer(
      assessment({
        origin: {
          kind: 'external_transfer',
          payerDocument: STRANGER_DOCUMENT,
          senderNameMatch: NO_NAME_MATCH,
        },
        relationship: { kind: 'intermediary' },
      }),
    );
    expect(routing.route).toBe('to_suspense');
  });
});

describe('маршрут не отвечает на вопрос, блокировать ли транш', () => {
  it('в результате нет поля о состоянии транша', () => {
    // Это развилка владельца (`INTAKE.md` §7.2): сегодня один тетри от
    // постороннего уводит транш в `release_blocked`, откуда выход только
    // действием человека. Удержание средств пакет обеспечивает; блокировку
    // состояния решает домен, и решать её за него здесь было бы подменой.
    const routing = routeByPayer(strangerAssessment());
    expect(Object.keys(routing).sort()).toEqual(['queueTask', 'reasons', 'route']);
  });
});

describe('маршрут по сопоставлению', () => {
  it('опознанное идёт на счёт клиента', () => {
    const routing = routeByMatch(matchIncoming([candidate()], POLICY));
    expect(routing.route).toBe('to_client_account');
    expect(routing.queueTask).toBeNull();
  });

  it('неопознанное не пропадает: непознанные плюс задача', () => {
    const routing = routeByMatch(matchIncoming([], POLICY));
    expect(routing.route).toBe('to_suspense');
    expect(routing.queueTask).toBe('intake_unmatched');
    expect(routing.reasons).toContain(INTAKE_REASON_KEYS.matchNoCandidate);
  });

  it('двусмысленное и ненайденное ведут в одно место, но разными причинами', () => {
    const ambiguous = routeByMatch(
      matchIncoming([candidate({ trancheId: 't1' }), candidate({ trancheId: 't2' })], POLICY),
    );
    expect(ambiguous.route).toBe('to_suspense');
    expect(ambiguous.reasons).toContain(INTAKE_REASON_KEYS.matchAmbiguous);
    expect(ambiguous.reasons).not.toContain(INTAKE_REASON_KEYS.matchNoCandidate);
  });
});

describe('удержание по плательщику сильнее любого сопоставления', () => {
  it('безошибочно опознанный платёж от постороннего на сделку не идёт', () => {
    const byMatch = routeByMatch(matchIncoming([candidate()], POLICY));
    const byPayer = routeByPayer(strangerAssessment());
    const combined = combineRouting(byMatch, byPayer);
    expect(byMatch.route).toBe('to_client_account');
    expect(combined.route).toBe('to_suspense');
    expect(combined.queueTask).toBe('payer_hold');
  });

  it('обе половины чистые — деньги идут на счёт клиента', () => {
    const combined = combineRouting(
      routeByMatch(matchIncoming([candidate()], POLICY)),
      routeByPayer(assessment()),
    );
    expect(combined.route).toBe('to_client_account');
    expect(combined.queueTask).toBeNull();
  });

  it('задача плательщика важнее задачи сопоставления', () => {
    const combined = combineRouting(
      routeByMatch(matchIncoming([], POLICY)),
      routeByPayer(strangerAssessment()),
    );
    expect(combined.queueTask).toBe('payer_hold');
  });
});
