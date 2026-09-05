import { describe, expect, it } from 'vitest';
import {
  type FxRates,
  type PlatformSpread,
  accountingFxDifference,
  isoDate,
  platformSpread,
  fxRates,
  rationalFromDecimalString,
} from '@sdelka/money';
import {
  type ClientConfirmation,
  type Quote,
  INTAKE_REASON_KEYS,
  PROPOSED_INTAKE_POLICY,
  decideConversion,
  disclosedMarkupBp,
  marketDriftBp,
  quote,
  quoteStatus,
} from '../src/index';
import { NOW, POLICY, at, usd } from './support/fixtures';

// Курс несёт свою пару: доллар за лари. Раньше пары не было, и конвертация в
// обратную сторону давала клиенту вшестеро больше, не роняя ни одного
// инварианта.
const RATES: FxRates<'USD', 'GEL'> = fxRates('USD', 'GEL', {
  // Клиентский хуже эталонного на 0,7% — наш спред.
  client: rationalFromDecimalString('2.66'),
  reference: rationalFromDecimalString('2.6787'),
  official: rationalFromDecimalString('2.6800'),
});

function makeQuote(): Quote<'USD', 'GEL'> {
  return quote<'USD', 'GEL'>(
    {
      quoteId: 'q-1',
      source: usd(8_000_000n),
      targetCurrency: 'GEL',
      rates: RATES,
      asOf: isoDate('2026-09-04'),
      issuedAt: NOW,
    },
    POLICY,
  );
}

const CONFIRMATION: ClientConfirmation = {
  quoteId: 'q-1',
  confirmedAt: NOW,
  partyId: 'party-1',
};

describe('дрейф рынка считается целочисленно', () => {
  it('движение на процент даёт сто базисных пунктов', () => {
    expect(
      marketDriftBp(rationalFromDecimalString('2.00'), rationalFromDecimalString('2.02')),
    ).toBe(100);
  });

  it('направление движения не важно: считается модуль', () => {
    const up = marketDriftBp(rationalFromDecimalString('2.00'), rationalFromDecimalString('2.10'));
    const down = marketDriftBp(rationalFromDecimalString('2.00'), rationalFromDecimalString('1.90'));
    expect(up).toBe(down);
  });

  it('неподвижный рынок даёт ноль', () => {
    expect(marketDriftBp(RATES.reference.value, RATES.reference.value)).toBe(0);
  });
});

describe('котировка гасится при движении рынка внутри срока', () => {
  it('рынок ушёл за порог до истечения срока — котировка аннулирована', () => {
    const moved = rationalFromDecimalString('2.7500');
    const report = quoteStatus(makeQuote(), moved, at(60_000));
    expect(report.status).toBe('voided_by_market_move');
    expect(report.reasons).toContain(INTAKE_REASON_KEYS.quoteVoidedByMarketMove);
  });

  it('движение в пределах порога срока не отменяет', () => {
    const nudged = rationalFromDecimalString('2.6800');
    expect(quoteStatus(makeQuote(), nudged, at(60_000)).status).toBe('firm');
  });

  it('срок истёк — котировка просрочена', () => {
    const report = quoteStatus(makeQuote(), RATES.reference.value, at(3 * 60 * 60 * 1000));
    expect(report.status).toBe('expired');
    // Причина называется, а не подразумевается: «срок истёк» и «рынок ушёл»
    // ведут клиента к разным действиям — подождать новую котировку или
    // пересогласовать курс, — и подменить одну другой значит послать его не туда.
    expect(report.reasons).toEqual([INTAKE_REASON_KEYS.quoteExpired]);
  });

  it('у каждого статуса своя причина, и она одна', () => {
    const moved = rationalFromDecimalString('2.7500');
    expect(quoteStatus(makeQuote(), moved, at(60_000)).reasons).toEqual([
      INTAKE_REASON_KEYS.quoteVoidedByMarketMove,
    ]);
    expect(quoteStatus(makeQuote(), RATES.reference.value, at(60_000)).reasons).toEqual([
      INTAKE_REASON_KEYS.quoteFirm,
    ]);
  });

  it('оба условия сразу — показывается уход рынка, а не часы', () => {
    const moved = rationalFromDecimalString('2.7500');
    const report = quoteStatus(makeQuote(), moved, at(3 * 60 * 60 * 1000));
    expect(report.status).toBe('voided_by_market_move');
  });

  it('граница срока: ровно в момент истечения котировка уже не тверда', () => {
    const report = quoteStatus(makeQuote(), RATES.reference.value, at(PROPOSED_INTAKE_POLICY.quote.validity));
    expect(report.status).toBe('expired');
  });

  it('граница порога: движение ровно на порог уже гасит котировку', () => {
    // Эталон 2,6787; сто базисных пунктов от него — ровно 0,026787.
    // Порог назван как «движение, при котором котировка гасится», и он
    // достигается равенством: иначе объявленный порог на пункт больше
    // действующего, а пункт здесь — это спред по всей паре.
    const atThreshold = rationalFromDecimalString('2.705487');
    const report = quoteStatus(makeQuote(), atThreshold, at(60_000));
    expect(report.driftBp).toBe(PROPOSED_INTAKE_POLICY.quote.driftThreshold.valueBp);
    expect(report.status).toBe('voided_by_market_move');
  });

  it('движение на пункт ниже порога котировку не гасит', () => {
    const belowThreshold = rationalFromDecimalString('2.705486');
    const report = quoteStatus(makeQuote(), belowThreshold, at(60_000));
    expect(report.driftBp).toBe(99);
    expect(report.status).toBe('firm');
  });
});

describe('конвертация невозможна без явного подтверждения', () => {
  it('подтверждения нет — отказ', () => {
    const decision = decideConversion(makeQuote(), RATES.reference.value, null, at(60_000), 'trunc');
    expect(decision.allowed).toBe(false);
    expect(decision.converted).toBeNull();
    // Отказ несёт свою причину **и** состояние котировки: клиенту показывается,
    // что подтвердить, и что именно он подтверждает.
    expect(decision.reasons).toEqual([
      INTAKE_REASON_KEYS.quoteConfirmationMissing,
      INTAKE_REASON_KEYS.quoteFirm,
    ]);
  });

  it('подтверждение выдано на другую котировку — не подходит', () => {
    const decision = decideConversion(
      makeQuote(),
      RATES.reference.value,
      { ...CONFIRMATION, quoteId: 'q-2' },
      at(60_000),
      'trunc',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain(INTAKE_REASON_KEYS.quoteConfirmationForOtherQuote);
  });

  it('котировка аннулирована — старое подтверждение не спасает', () => {
    const moved = rationalFromDecimalString('2.7500');
    const decision = decideConversion(makeQuote(), moved, CONFIRMATION, at(60_000), 'trunc');
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('voided_by_market_move');
  });

  it('срок истёк — молчаливого пересчёта не происходит', () => {
    const decision = decideConversion(
      makeQuote(),
      RATES.reference.value,
      CONFIRMATION,
      at(3 * 60 * 60 * 1000),
      'trunc',
    );
    expect(decision.allowed).toBe(false);
    expect(decision.converted).toBeNull();
    // Причина отказа — истечение срока, а не отсутствие подтверждения:
    // подтверждение было, и требовать его заново клиента только запутает.
    expect(decision.reasons).toEqual([INTAKE_REASON_KEYS.quoteExpired]);
  });

  it('твёрдая котировка с подтверждением конвертируется', () => {
    const decision = decideConversion(
      makeQuote(),
      RATES.reference.value,
      CONFIRMATION,
      at(60_000),
      'trunc',
    );
    expect(decision.allowed).toBe(true);
    expect(decision.converted?.target.currency).toBe('GEL');
    expect(decision.converted?.rates).toBe(RATES);
    // Разрешённая конвертация помечена твёрдостью котировки. Причина «рынок
    // ушёл» на разрешённой операции — прямое противоречие в том, что видит
    // клиент: деньги сконвертированы по курсу, объявленному недействительным.
    expect(decision.reasons).toEqual([INTAKE_REASON_KEYS.quoteFirm]);
  });
});

describe('три курса и раскрытие наценки', () => {
  it('котировка хранит все три курса вместе', () => {
    const value = makeQuote();
    expect(value.rates.client).toBeDefined();
    expect(value.rates.reference).toBeDefined();
    expect(value.rates.official).toBeDefined();
  });

  it('наценка раскрывается в базисных пунктах и считается от эталонного курса', () => {
    // (2,6787 − 2,66) / 2,6787 ≈ 0,698% ≈ 69 б.п.
    expect(disclosedMarkupBp(RATES)).toBe(69);
  });

  it('клиентский курс лучше эталонного даёт отрицательную наценку, а не ноль', () => {
    const generous: FxRates<'USD', 'GEL'> = fxRates('USD', 'GEL', {
      client: rationalFromDecimalString('2.70'),
      reference: RATES.reference.value,
      official: RATES.official.value,
    });
    expect(disclosedMarkupBp(generous)).toBeLessThan(0);
  });
});

describe('надгробие: спред и учётная курсовая разница не складываются', () => {
  it('это разные типы, и одно нельзя выдать за другое', () => {
    const decision = decideConversion(
      makeQuote(),
      RATES.reference.value,
      CONFIRMATION,
      at(60_000),
      'trunc',
    );
    const converted = decision.converted;
    expect(converted).not.toBeNull();
    if (converted === null) return;

    const spread = platformSpread(converted, 'trunc');
    const accounting = accountingFxDifference(converted, 'trunc');

    // Обе величины существуют, обе в лари, и они **не равны**: спред считается от
    // эталонного курса, учётная разница — от официального (`FUNCTIONAL.md` §4.5,
    // `CORE.md` Ф5). Смешать их — значит показать в отчётности одно вместо другого.
    expect(spread.kind).toBe('platform_spread');
    expect(accounting.kind).toBe('accounting_fx_difference');
    expect(spread.amount.minor).not.toBe(accounting.amount.minor);

    // @ts-expect-error — типы разведены намеренно: присвоить одно другому нельзя,
    // и распаковка до `Money` обязана быть осознанной, а не побочной.
    const forbidden: PlatformSpread<'GEL'> = accounting;
    expect(forbidden.kind).toBe('accounting_fx_difference');
  });
});
