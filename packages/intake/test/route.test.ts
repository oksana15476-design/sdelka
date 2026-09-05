import { describe, expect, it } from 'vitest';
import {
  type DetectorOutcome,
  type PayerAssessment,
  DETECTOR_OUTCOMES,
  POLICY_2026_09_03,
  decision,
} from '@sdelka/compliance';
import {
  type CandidateSignals,
  type IntakeRoute,
  type IntakeRouting,
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
  NOW,
  POLICY,
  STRANGER_DOCUMENT,
  assessment,
  spouseAssessment,
  strangerAssessment,
} from './support/fixtures';

const REFERENCE = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });

/**
 * Решение о плательщике с заданным исходом, собранное напрямую.
 *
 * Лестница исходов шире того, что сегодня выдаёт `assessPayer`: ступень `stop`
 * не порождается ни одной его веткой. Маршрут для неё в таблице приёма тем не
 * менее назван, и назван не «на всякий случай» — `stop` означает остановку
 * операции, и деньги при нём на сделку не идут. Проверить это настоящим
 * детектором нечем, поэтому решение собирается здесь.
 *
 * Правило плательщика этим не переписывается: проверяется перевод исхода в
 * маршрут, а не то, откуда исход взялся. Ветки, которые детектор порождает,
 * проверяются настоящими решениями — ниже и в фикстурах.
 */
function assessedAs(
  outcome: DetectorOutcome,
  exceptionApplied: PayerAssessment['exceptionApplied'] = null,
): PayerAssessment {
  return Object.freeze({
    ...decision<DetectorOutcome>(outcome, POLICY_2026_09_03.version, NOW, []),
    exceptionApplied,
  });
}

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
    // Причина названа: маршрут виден оператору строкой, а не только полем.
    expect(routing.reasons).toEqual([INTAKE_REASON_KEYS.routeToClientAccount]);
  });

  it('каждая ступень лестницы переводится в свой маршрут, задачу и причину', () => {
    // Таблица тотальная и проверяется целиком: пропущенная ступень — это деньги,
    // ушедшие не туда, а не отсутствующая строка в отчёте.
    const table = DETECTOR_OUTCOMES.map((outcome) => {
      const routing = routeByPayer(assessedAs(outcome));
      return [outcome, routing.route, routing.queueTask, [...routing.reasons]];
    });
    const suspense = [
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.routePayerHold,
    ];
    expect(table).toEqual([
      ['clear', 'to_client_account', null, [INTAKE_REASON_KEYS.routeToClientAccount]],
      ['review', 'to_client_account', 'payer_hold', [INTAKE_REASON_KEYS.routeToClientAccount]],
      ['stop', 'to_suspense', 'payer_hold', suspense],
      ['hold', 'to_suspense', 'payer_hold', suspense],
      ['block', 'to_suspense', 'payer_hold', suspense],
    ]);
  });

  it('разбор без исключения и разбор по исключению — разные задачи оператору', () => {
    // Обе ветки ведут деньги на счёт клиента, и различает их только вид задачи:
    // в первой оператор проверяет плательщика, во второй — подтверждает уже
    // применённое исключение. Один вид на оба случая стоил бы лишнего круга.
    expect(routeByPayer(assessedAs('review', null)).queueTask).toBe('payer_hold');
    expect(routeByPayer(assessedAs('review', 'spouse')).queueTask).toBe('payer_exception');
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
    expect(routing.reasons).toEqual([INTAKE_REASON_KEYS.routeToClientAccount]);
  });

  it('платёж от постороннего не попадает на счёт клиента ни при какой сумме', () => {
    const routing = routeByPayer(strangerAssessment());
    expect(routing.route).toBe('to_suspense');
    expect(routing.queueTask).toBe('payer_hold');
    // Две причины и в этом порядке: куда легли деньги и почему. Первая
    // отвечает на вопрос клиента «где мой платёж», вторая — на вопрос
    // оператора «что с ним делать».
    expect(routing.reasons).toEqual([
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.routePayerHold,
    ]);
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
    // Причина одна и это причина сопоставления: деньги легли на счёт клиента
    // потому, что сделка опознана, а не потому, что маршрут такой по умолчанию.
    expect(routing.reasons).toEqual([INTAKE_REASON_KEYS.matchAuto]);
  });

  it('неопознанное не пропадает: непознанные плюс задача', () => {
    const routing = routeByMatch(matchIncoming([], POLICY));
    expect(routing.route).toBe('to_suspense');
    expect(routing.queueTask).toBe('intake_unmatched');
    expect(routing.reasons).toEqual([
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.matchNoCandidate,
    ]);
  });

  it('двусмысленное и ненайденное ведут в одно место, но разными причинами', () => {
    const ambiguous = routeByMatch(
      matchIncoming([candidate({ trancheId: 't1' }), candidate({ trancheId: 't2' })], POLICY),
    );
    expect(ambiguous.route).toBe('to_suspense');
    expect(ambiguous.reasons).toEqual([
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.matchAmbiguous,
    ]);
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

  it('одна и та же причина в своде не повторяется', () => {
    // Обе половины пришли в непознанные и обе назвали это своей причиной.
    // Повтор виден клиенту и оператору буквально — одна строка дважды подряд, —
    // и читается как два разных события с одним текстом.
    const byMatch = routeByMatch(matchIncoming([], POLICY));
    const byPayer = routeByPayer(strangerAssessment());
    expect(byMatch.reasons).toContain(INTAKE_REASON_KEYS.routeToSuspense);
    expect(byPayer.reasons).toContain(INTAKE_REASON_KEYS.routeToSuspense);

    const combined = combineRouting(byMatch, byPayer);
    expect(combined.reasons).toEqual([
      INTAKE_REASON_KEYS.routeToSuspense,
      INTAKE_REASON_KEYS.matchNoCandidate,
      INTAKE_REASON_KEYS.routePayerHold,
    ]);
    expect(new Set(combined.reasons).size).toBe(combined.reasons.length);
  });

  it('счёт клиента получается только из двух чистых половин', () => {
    const half = (route: IntakeRoute): IntakeRouting =>
      Object.freeze({ route, queueTask: null, reasons: Object.freeze([]) });
    const combined = (left: IntakeRoute, right: IntakeRoute): IntakeRoute =>
      combineRouting(half(left), half(right)).route;

    expect(combined('to_client_account', 'to_client_account')).toBe('to_client_account');
    expect(combined('to_suspense', 'to_client_account')).toBe('to_suspense');
    expect(combined('to_client_account', 'to_suspense')).toBe('to_suspense');
    expect(combined('to_suspense', 'to_suspense')).toBe('to_suspense');
  });
});
