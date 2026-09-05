import { describe, expect, it } from 'vitest';
import {
  type LegState,
  type TransferTracking,
  INTAKE_REASON_KEYS,
  LEG_IS_OBSERVABLE,
  TRANSFER_LEGS,
  medianShortfall,
  trackingView,
} from '../src/index';
import { NOW, at, gel, usd } from './support/fixtures';

function declared(leg: LegState['leg'], expectedBy: number | null = null): LegState {
  return {
    leg,
    evidence: { kind: 'declared_by_party', declaredAt: at(-3_600_000), documentRef: 'swift-copy-1' },
    expectedBy: expectedBy === null ? null : at(expectedBy),
  };
}

function observed(leg: LegState['leg'], expectedBy: number | null = null): LegState {
  return {
    leg,
    evidence: { kind: 'observed_by_us', observedAt: at(-60_000), sourceRef: 'statement-line-42' },
    expectedBy: expectedBy === null ? null : at(expectedBy),
  };
}

describe('граница нашей ответственности показана, а не имитирована', () => {
  it('участок «в пути» не наблюдаем нами никогда', () => {
    expect(LEG_IS_OBSERVABLE.in_flight).toBe(false);
    expect(LEG_IS_OBSERVABLE.left_sender_bank).toBe(false);
    expect(LEG_IS_OBSERVABLE.credited_unidentified).toBe(true);
    expect(LEG_IS_OBSERVABLE.credited_to_deal).toBe(true);
  });

  it('заявленное стороной не выдаётся за наше наблюдение', () => {
    const tracking: TransferTracking = { legs: [declared('left_sender_bank')] };
    const view = trackingView(tracking, NOW);
    expect(view.currentLeg).toBe('left_sender_bank');
    expect(view.currentIsOurs).toBe(false);
    expect(view.reasons).toContain(INTAKE_REASON_KEYS.trackingLegDeclared);
  });

  it('наше наблюдение помечено как наше', () => {
    const tracking: TransferTracking = { legs: [observed('credited_unidentified')] };
    const view = trackingView(tracking, NOW);
    expect(view.currentIsOurs).toBe(true);
    expect(view.reasons).toContain(INTAKE_REASON_KEYS.trackingLegObserved);
  });

  it('ненаблюдаемый участок не становится текущим состоянием', () => {
    const tracking: TransferTracking = {
      legs: [declared('left_sender_bank'), { leg: 'in_flight', evidence: { kind: 'not_observable' }, expectedBy: null }],
    };
    expect(trackingView(tracking, NOW).currentLeg).toBe('left_sender_bank');
  });

  it('нечего показать — так и говорится, а не выдумывается участок', () => {
    const view = trackingView({ legs: [] }, NOW);
    expect(view.currentLeg).toBeNull();
    expect(view.reasons).toContain(INTAKE_REASON_KEYS.trackingLegNotObservable);
  });
});

describe('порядок участков задан перечнем, а не временем', () => {
  it('наше вчерашнее зачисление не отодвигается сегодняшним заявлением стороны', () => {
    const tracking: TransferTracking = {
      legs: [
        { leg: 'left_sender_bank', evidence: { kind: 'declared_by_party', declaredAt: at(3_600_000), documentRef: null }, expectedBy: null },
        observed('credited_to_deal'),
      ],
    };
    expect(trackingView(tracking, NOW).currentLeg).toBe('credited_to_deal');
  });

  it('перечень участков закрыт', () => {
    expect([...TRANSFER_LEGS]).toEqual([
      'left_sender_bank',
      'in_flight',
      'credited_unidentified',
      'credited_to_deal',
    ]);
  });
});

describe('сторона видит просрочку сама', () => {
  it('срок прошёл — участок помечен просроченным', () => {
    const view = trackingView({ legs: [declared('left_sender_bank', -1_000)] }, NOW);
    expect(view.overdue).toBe(true);
    expect(view.reasons).toContain(INTAKE_REASON_KEYS.trackingOverdue);
  });

  it('срока не обещали — просрочки нет', () => {
    expect(trackingView({ legs: [declared('left_sender_bank')] }, NOW).overdue).toBe(false);
  });

  it('ровно в обещанный момент просрочки ещё нет', () => {
    // Обещание «к такому-то моменту» этим моментом исполняется, а не
    // нарушается. Иначе сторона видит красную отметку на секунду раньше срока.
    const view = trackingView({ legs: [declared('left_sender_bank', 0)] }, NOW);
    expect(view.overdue).toBe(false);
    expect(view.reasons).not.toContain(INTAKE_REASON_KEYS.trackingOverdue);
  });

  it('на миллисекунду позже обещанного — уже просрочка', () => {
    expect(trackingView({ legs: [declared('left_sender_bank', -1)] }, NOW).overdue).toBe(true);
  });
});

describe('медиана потерь на корреспондентах', () => {
  it('нечётное число наблюдений — середина', () => {
    const median = medianShortfall([gel(100n), gel(500n), gel(300n)]);
    expect(median?.minor).toBe(300n);
  });

  it('чётное число — меньшее из двух средних, а не полусумма', () => {
    // Полусумма 100 и 301 дала бы 200,5 — дробную минорную единицу, то есть
    // плавающую точку в денежном домене (красная линия №4).
    const median = medianShortfall([gel(100n), gel(301n)]);
    expect(median?.minor).toBe(100n);
  });

  it('наблюдений нет — величины нет, а не ноль', () => {
    expect(medianShortfall([])).toBeNull();
  });

  it('смешение валют отвергается', () => {
    expect(() => medianShortfall([gel(100n), usd(100n)])).toThrow();
  });
});
