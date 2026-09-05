import { money } from '@sdelka/money';
import { SETTINGS_REFUSAL_KEYS } from '@sdelka/settings';
import { describe, expect, it } from 'vitest';
import {
  type TariffSeries,
  bornByPayer,
  quoteTrancheTariff,
  tariffAtTrancheCreation,
  tariffPlan,
  tariffSeries,
  tariffSeriesFromStore,
  tariffVersionRef,
} from '../src/index';
import { at, version } from './support/fixtures';

const PRINCIPAL = money('GEL', 21_349_500n);

const CHEAP = tariffPlan({ rateBp: 50, currency: 'GEL' });
const DEAR = tariffPlan({ rateBp: 100, currency: 'GEL' });

/**
 * Журнал из двух версий: 0,5 % с самого начала, 1 % — с десятого часа.
 *
 * Ровно та проба, ради которой существует прилипание: транш, заведённый до
 * десятого часа, обязан считаться по 0,5 % и после него.
 */
function twoVersions(): TariffSeries {
  const built = tariffSeriesFromStore([
    version({
      id: 'tariff/2026-09-04.1',
      value: CHEAP,
      recordedAt: at(0),
      effectiveFrom: at(0),
      supersedes: null,
    }),
    version({
      id: 'tariff/2026-09-04.2',
      value: DEAR,
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: 'tariff/2026-09-04.1',
    }),
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

describe('изменение тарифа не переписывает задним числом уже посчитанные сделки', () => {
  it('транш, созданный до изменения, считается по прежней версии и после него', () => {
    const series = twoVersions();

    const before = quoteTrancheTariff(series, at(1), PRINCIPAL);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.fee.minor).toBe(106_747n);
    expect(tariffVersionRef(before.value)).toBe('tariff/2026-09-04.1');

    // Тот же транш, тарифицированный после того, как владелец удвоил ставку:
    // момент создания в прошлом, и ответ обязан не измениться ни на тетри.
    const again = quoteTrancheTariff(series, at(1), PRINCIPAL);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.fee.minor).toBe(before.value.fee.minor);
    expect(again.value.versionId).toBe(before.value.versionId);
  });

  it('транш, созданный после изменения, считается по новой версии', () => {
    const after = quoteTrancheTariff(twoVersions(), at(20), PRINCIPAL);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.fee.minor).toBe(213_495n);
    expect(tariffVersionRef(after.value)).toBe('tariff/2026-09-04.2');
  });

  it('на границе действует новая версия: `effectiveFrom ≤ момент`', () => {
    const onBoundary = quoteTrancheTariff(twoVersions(), at(10), PRINCIPAL);
    expect(onBoundary.ok).toBe(true);
    if (!onBoundary.ok) return;
    expect(onBoundary.value.versionId).toBe('tariff/2026-09-04.2');
  });

  it('отложенное изменение не действует до своего момента', () => {
    const built = tariffSeriesFromStore([
      version({
        id: 'tariff/2026-09-04.1',
        value: CHEAP,
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'tariff/2026-09-04.2',
        value: DEAR,
        // Записано сейчас, вступает через сутки: `recordedAt` и `effectiveFrom`
        // — разные поля намеренно.
        recordedAt: at(1),
        effectiveFrom: at(24),
        supersedes: 'tariff/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const now = quoteTrancheTariff(built.value, at(2), PRINCIPAL);
    expect(now.ok).toBe(true);
    if (!now.ok) return;
    expect(now.value.versionId).toBe('tariff/2026-09-04.1');
    expect(now.value.fee.minor).toBe(106_747n);
  });

  it('смена плательщика тоже не трогает прошлое: у транша своя версия', () => {
    const built = tariffSeriesFromStore([
      version({
        id: 'tariff/2026-09-04.1',
        value: CHEAP,
        recordedAt: at(0),
        effectiveFrom: at(0),
        supersedes: null,
      }),
      version({
        id: 'tariff/2026-09-04.2',
        value: tariffPlan({ rateBp: 50, currency: 'GEL', bearing: bornByPayer() }),
        recordedAt: at(10),
        effectiveFrom: at(10),
        supersedes: 'tariff/2026-09-04.1',
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const old = quoteTrancheTariff(built.value, at(1), PRINCIPAL);
    const fresh = quoteTrancheTariff(built.value, at(11), PRINCIPAL);
    expect(old.ok && fresh.ok).toBe(true);
    if (!old.ok || !fresh.ok) return;
    // Требуемая сумма старого транша не сдвинулась: человек уже отправил её.
    expect(old.value.required.minor).toBe(21_349_500n);
    expect(fresh.value.required.minor).toBe(21_456_247n);
  });
});

describe('умолчания нет: отсутствие действующей версии — отказ, а не подставленное число', () => {
  it('пустой журнал не даёт тарифа', () => {
    const empty = quoteTrancheTariff(tariffSeries(), at(1), PRINCIPAL);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('момент раньше первой версии не берёт ни первую, ни сегодняшнюю', () => {
    // Взять сегодняшнюю значило бы посчитать транш по тарифу, принятому после
    // его создания, — тот же пересчёт задним числом, только с другой стороны.
    const early = quoteTrancheTariff(twoVersions(), at(-1), PRINCIPAL);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('спросить у журнала тарифа «а что сейчас» нельзя: момент называет себя сам', () => {
    const series = twoVersions();
    const resolved = tariffAtTrancheCreation(series, at(1));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.strategy).toBe('sticky');
    expect(resolved.value.applied.versionId).toBe('tariff/2026-09-04.1');
  });
});
