import { HOUR } from '@sdelka/domain';
import { money } from '@sdelka/money';
import { SETTINGS_REFUSAL_KEYS } from '@sdelka/settings';
import { describe, expect, it } from 'vitest';
import {
  type AmountToleranceSeries,
  type DealCurrenciesSeries,
  type QueueAgeSeries,
  LIMITS_REFUSAL_KEYS,
  amountTolerance,
  amountToleranceAtDisclosure,
  amountToleranceSeriesFromStore,
  dealCurrenciesSeries,
  dealCurrenciesSeriesFromStore,
  dealCurrencyAdmittedAt,
  materialitySeriesFromStore,
  materialityThreshold,
  materialityThresholdAt,
  queueAgeBands,
  queueAgeBandsAt,
  queueAgeSeriesFromStore,
  dealCurrencyList,
} from '../src/index';
import { at, version } from './support/fixtures';

const DOC = 'docs/product/SETTINGS.md';

/**
 * Журнал перечня из двух версий: лари с долларом с самого начала, один лари —
 * с десятого часа.
 *
 * Ровно та проба, ради которой существует прилипание: сделка, заведённая до
 * десятого часа в долларах, обязана оставаться обслуживаемой и после него.
 */
function currenciesWithdrawnAtTen(): DealCurrenciesSeries {
  const built = dealCurrenciesSeriesFromStore([
    version({
      id: 'deal_currencies/2026-09-04.1',
      value: dealCurrencyList(['GEL', 'USD']),
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'deal_currencies/2026-09-04.2',
      value: dealCurrencyList(['GEL']),
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'deal_currencies/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

describe('выключение валюты действует только на новые сделки', () => {
  it('сделка, заведённая до выключения, продолжает считаться в этой валюте', () => {
    const series = currenciesWithdrawnAtTen();

    const old = dealCurrencyAdmittedAt(series, at(1), 'USD');
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    expect(old.value.versionId).toBe('deal_currencies/2026-09-04.1');

    // Тот же вопрос, заданный после выключения: момент создания сделки в
    // прошлом, и ответ обязан не измениться.
    const again = dealCurrencyAdmittedAt(series, at(1), 'USD');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.versionId).toBe(old.value.versionId);
  });

  it('новая сделка в выключенной валюте не заводится', () => {
    const fresh = dealCurrencyAdmittedAt(currenciesWithdrawnAtTen(), at(11), 'USD');
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.error).toBe(LIMITS_REFUSAL_KEYS.currencyNotAdmittedAtDealCreation);
    }
  });

  it('на границе действует новая версия: `effectiveFrom ≤ момент`', () => {
    const onBoundary = dealCurrencyAdmittedAt(currenciesWithdrawnAtTen(), at(10), 'USD');
    expect(onBoundary.ok).toBe(false);
  });

  it('лари обслуживается по обе стороны от изменения', () => {
    const series = currenciesWithdrawnAtTen();
    expect(dealCurrencyAdmittedAt(series, at(1), 'GEL').ok).toBe(true);
    expect(dealCurrencyAdmittedAt(series, at(11), 'GEL').ok).toBe(true);
  });
});

describe('включение валюты не действует задним числом', () => {
  it('сделка, заведённая до включения, валюту не получает', () => {
    const built = dealCurrenciesSeriesFromStore([
      version({
        id: 'deal_currencies/2026-09-04.1',
        value: dealCurrencyList(['GEL']),
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'deal_currencies/2026-09-04.2',
        value: dealCurrencyList(['GEL', 'EUR']),
        recordedAt: at(10),
        effectiveFrom: at(10),
        supersedes: 'deal_currencies/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(dealCurrencyAdmittedAt(built.value, at(1), 'EUR').ok).toBe(false);
    expect(dealCurrencyAdmittedAt(built.value, at(11), 'EUR').ok).toBe(true);
  });
});

describe('умолчания нет: отсутствие действующей версии — отказ, а не подставленный перечень', () => {
  it('пустой журнал не допускает ни одной валюты', () => {
    const empty = dealCurrencyAdmittedAt(dealCurrenciesSeries(), at(1), 'GEL');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('момент раньше первой версии не берёт ни первую, ни сегодняшнюю', () => {
    const early = dealCurrencyAdmittedAt(currenciesWithdrawnAtTen(), at(-1), 'GEL');
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });
});

/* ------------------------------------------------------------------------- */
/* Пороги: версия на момент решения не переписывается позже                  */
/* ------------------------------------------------------------------------- */

const WIDE = amountTolerance({
  absolute: [money('GEL', 5_000n)],
  shareBp: 50,
  rationaleDocRef: DOC,
});
const NARROW = amountTolerance({
  absolute: [money('GEL', 2_000n)],
  shareBp: 20,
  rationaleDocRef: DOC,
});

function toleranceNarrowedAtTen(): AmountToleranceSeries {
  const built = amountToleranceSeriesFromStore([
    version({
      id: 'amount_tolerance/2026-09-04.1',
      value: WIDE,
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'amount_tolerance/2026-09-04.2',
      value: NARROW,
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'amount_tolerance/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

describe('допуск: версия, действовавшая в момент раскрытия, остаётся при этом раскрытии', () => {
  it('раскрытие до сужения читается прежней версией и после сужения', () => {
    const series = toleranceNarrowedAtTen();
    const disclosed = amountToleranceAtDisclosure(series, at(1));
    expect(disclosed.ok).toBe(true);
    if (!disclosed.ok) return;
    expect(disclosed.value.applied.versionId).toBe('amount_tolerance/2026-09-04.1');
    expect(disclosed.value.applied.value.absolute[0]?.minor).toBe(5_000n);

    const later = amountToleranceAtDisclosure(series, at(1));
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.value.applied.versionId).toBe(disclosed.value.applied.versionId);
    expect(later.value.applied.value).toEqual(disclosed.value.applied.value);
  });

  it('раскрытие после сужения читается новой версией', () => {
    const disclosed = amountToleranceAtDisclosure(toleranceNarrowedAtTen(), at(11));
    expect(disclosed.ok).toBe(true);
    if (!disclosed.ok) return;
    expect(disclosed.value.applied.versionId).toBe('amount_tolerance/2026-09-04.2');
  });

  it('третья версия, легшая сверху, не переписывает ответ на прошлый момент', () => {
    // Правка задним числом невозможна не правилом, а построением: версию с
    // `effectiveFrom` раньше `recordedAt` не собрать вовсе, а `recordedAt`
    // новой версии не раньше предыдущей. Значит множество версий, действующих
    // на прошлый момент, только замкнуто — дописать в него нечего.
    const before = amountToleranceAtDisclosure(toleranceNarrowedAtTen(), at(1));
    const built = amountToleranceSeriesFromStore([
      ...toleranceNarrowedAtTen().versions,
      version({
        id: 'amount_tolerance/2026-09-04.3',
        value: WIDE,
        recordedAt: at(20),
        effectiveFrom: at(20),
        supersedes: 'amount_tolerance/2026-09-04.2',
      }),
    ]);
    expect(built.ok && before.ok).toBe(true);
    if (!built.ok || !before.ok) return;
    const after = amountToleranceAtDisclosure(built.value, at(1));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.applied.versionId).toBe(before.value.applied.versionId);
    expect(after.value.applied.value).toEqual(before.value.applied.value);
  });

  it('отложенное изменение не действует до своего момента', () => {
    const built = amountToleranceSeriesFromStore([
      version({
        id: 'amount_tolerance/2026-09-04.1',
        value: WIDE,
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'amount_tolerance/2026-09-04.2',
        value: NARROW,
        recordedAt: at(1),
        effectiveFrom: at(24),
        supersedes: 'amount_tolerance/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const now = amountToleranceAtDisclosure(built.value, at(2));
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.value.applied.versionId).toBe('amount_tolerance/2026-09-04.1');
  });
});

describe('границы очереди и порог значимости: не прилипают, но прошлое читается прежней версией', () => {
  function queue(): QueueAgeSeries {
    const built = queueAgeSeriesFromStore([
      version({
        id: 'queue_age/2026-09-04.1',
        value: queueAgeBands({
          escalationAfterMs: [4 * HOUR, 24 * HOUR],
          rankCurrency: 'GEL',
          rationaleDocRef: DOC,
        }),
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'queue_age/2026-09-04.2',
        value: queueAgeBands({
          escalationAfterMs: [1 * HOUR, 4 * HOUR],
          rankCurrency: 'GEL',
          rationaleDocRef: DOC,
        }),
        recordedAt: at(10),
        effectiveFrom: at(10),
        supersedes: 'queue_age/2026-09-04.1',
      }),
    ]);
    if (!built.ok) throw new Error(built.error);
    return built.value;
  }

  it('ужесточение границ действует сразу на все задачи, наблюдаемые после него', () => {
    const now = queueAgeBandsAt(queue(), at(11));
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.value.strategy).toBe('immediate');
    expect(now.value.applied.value.escalationAfter[0] as number).toBe(1 * HOUR);
  });

  it('уровень, назначенный вчерашнему наблюдению, вчерашней версией и остаётся', () => {
    const yesterday = queueAgeBandsAt(queue(), at(1));
    expect(yesterday.ok).toBe(true);
    if (!yesterday.ok) return;
    expect(yesterday.value.applied.versionId).toBe('queue_age/2026-09-04.1');
    expect(yesterday.value.applied.value.escalationAfter[0] as number).toBe(4 * HOUR);
  });

  it('порог значимости на дату наблюдения — версия той даты, а не сегодняшняя норма', () => {
    const built = materialitySeriesFromStore([
      version({
        id: 'materiality/2026-09-04.1',
        value: materialityThreshold({
          monthlyTurnover: money('GEL', 900_000_000n),
          warnAtBp: 7_500,
          rationaleDocRef: DOC,
        }),
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'materiality/2026-09-04.2',
        value: materialityThreshold({
          monthlyTurnover: money('GEL', 1_200_000_000n),
          warnAtBp: 7_500,
          rationaleDocRef: DOC,
        }),
        recordedAt: at(10),
        effectiveFrom: at(10),
        supersedes: 'materiality/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const past = materialityThresholdAt(built.value, at(1));
    const present = materialityThresholdAt(built.value, at(11));
    expect(past.ok && present.ok).toBe(true);
    if (!past.ok || !present.ok) return;
    expect(past.value.applied.value.monthlyTurnover.minor).toBe(900_000_000n);
    expect(present.value.applied.value.monthlyTurnover.minor).toBe(1_200_000_000n);
  });
});
