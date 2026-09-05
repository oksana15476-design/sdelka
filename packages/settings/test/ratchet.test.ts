import { describe, expect, it } from 'vitest';
import {
  SETTINGS_OUTCOME_KEYS,
  SETTINGS_REFUSAL_KEYS,
  SettingsError,
  type SettingsSeries,
  type StrictnessOrder,
  resolveWithTighteningRatchet,
  settingsSeries,
  settingsSeriesFromStore,
  stickingMoment,
  strictnessOrder,
  tighteningMoment,
  versionInEffect,
} from '../src/index';
import { type ChainSpec, type Tier, at, chain } from './support/fixtures';

/**
 * Порядок строгости для непрозрачной метки: `unreachable` строже `strict`,
 * `strict` строже `soft`. Ни одной величины: тест проверяет храповик, а не
 * лестницу порогов, которой в пакете нет и до ответа владельца не будет.
 */
const RANK: Readonly<Record<Tier, number>> = { soft: 0, strict: 1, unreachable: 2 };

const ORDER: StrictnessOrder<Tier> = strictnessOrder<Tier>({
  docRef: 'docs/product/SETTINGS.md#в4-пороги-утверждения-выплаты',
  compareStrictness: (left, right) => {
    const l = RANK[left];
    const r = RANK[right];
    return l === r ? 0 : l > r ? 1 : -1;
  },
  isUnreachable: (value) => value === 'unreachable',
});

function ladder(specs: readonly ChainSpec[]): SettingsSeries<Tier, 'tranche_created'> {
  const built = settingsSeriesFromStore<Tier, 'tranche_created'>(
    'probe',
    'tranche_created',
    chain(specs),
  );
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

const STUCK = stickingMoment('tranche_created', at(10));
const NOW = tighteningMoment(at(100));

describe('храповик: строжайшее из прилипшей версии и текущей', () => {
  it('ужесточение действует на живой транш', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
      { id: 'probe/2026-09-04.2', value: 'strict', recordedAt: at(50), effectiveFrom: at(50) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.value).toBe('strict');
    expect(resolved.value.strategy).toBe('tightening_ratchet');
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.ratchetTightened);
  });

  it('смягчение не действует: выплата не становится легче', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'strict', recordedAt: at(1), effectiveFrom: at(1) },
      { id: 'probe/2026-09-04.2', value: 'soft', recordedAt: at(50), effectiveFrom: at(50) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.value).toBe('strict');
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.ratchetSofteningNotApplied);
  });

  it('недостижимое значение к живому траншу не применяется', () => {
    // Красная линия №7: понижение потолка закрывает вход, а не запирает выход.
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
      { id: 'probe/2026-09-04.2', value: 'unreachable', recordedAt: at(50), effectiveFrom: at(50) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.value).toBe('soft');
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.ratchetUnreachableNotApplied);
    // Оговорка не отменяет храповик: она отменяет только этот шаг. Порядок
    // строгости считает `unreachable` строжайшим — и без оговорки версия прошла бы.
    expect(ORDER.compareStrictness('unreachable', 'soft')).toBe(1);
  });

  it('версия не менялась — исход назван отдельно', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'strict', recordedAt: at(1), effectiveFrom: at(1) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.ratchetUnchanged);
  });

  it('в момент прилипания версии не было — действует текущая', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'strict', recordedAt: at(50), effectiveFrom: at(50) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.value).toBe('strict');
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.ratchetNoStuckVersion);
  });

  it('версий нет вовсе — отказ, а не контрольная мера из пустого журнала', () => {
    // Падает, если храповик вернёт успех с пустым `applied`: «версии нет» — это
    // отказ и здесь, иначе он был бы способом обойти пустую историю.
    const empty = settingsSeries<Tier, 'tranche_created'>('probe', 'tranche_created');
    const resolved = resolveWithTighteningRatchet(empty, STUCK, NOW, ORDER);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('«сейчас» раньше момента прилипания — отказ, а не мнимое ужесточение', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
    ]);
    const resolved = resolveWithTighteningRatchet(series, STUCK, tighteningMoment(at(5)), ORDER);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.momentsOutOfOrder);
  });

  it('момент чужого события не принимается и здесь', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
    ]);
    const resolved = resolveWithTighteningRatchet(
      series,
      // @ts-expect-error — журнал прилипает к созданию транша, а не к котировке.
      stickingMoment('quote_issued', at(10)),
      NOW,
      ORDER,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  });
});

describe('храповик — исключение, а не поведение резолвера', () => {
  it('обычное разрешение ужесточение не подхватывает', () => {
    // Тот же журнал, тот же момент: без храповика действует прилипшая версия.
    // Проверка падает, если ужесточение переедет веткой в общий резолвер.
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
      { id: 'probe/2026-09-04.2', value: 'strict', recordedAt: at(50), effectiveFrom: at(50) },
    ]);
    const plain = versionInEffect(series, STUCK);
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.value.strategy).toBe('sticky');
    expect(plain.value.applied.value).toBe('soft');
  });

  it('порядок строгости без ссылки на документ не собирается', () => {
    expect(() =>
      strictnessOrder<Tier>({
        docRef: '   ',
        compareStrictness: () => 0,
        isUnreachable: () => false,
      }),
    ).toThrow(SettingsError);
  });

  it('храповик не получить, не назвав ни порядка строгости, ни момента', () => {
    const series = ladder([
      { id: 'probe/2026-09-04.1', value: 'soft', recordedAt: at(1), effectiveFrom: at(1) },
    ]);
    // @ts-expect-error — без порядка строгости стратегии не существует.
    const resolved = resolveWithTighteningRatchet(series, STUCK, NOW);
    expect(resolved).toBeDefined();
  });
});
