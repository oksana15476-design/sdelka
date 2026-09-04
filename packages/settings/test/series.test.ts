import type { Result } from '@sdelka/domain';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_REFUSAL_KEYS,
  type SettingsRefusalKey,
  type SettingsSeries,
  appendSettingsVersion,
  findSettingsVersion,
  settingsSeries,
  settingsSeriesFromStore,
  settingsVersionId,
} from '../src/index';
import { type Tier, type VersionSpec, at, version } from './support/fixtures';

const EMPTY: SettingsSeries<Tier, 'tranche_created'> = settingsSeries('probe', 'tranche_created');

function append(
  series: SettingsSeries<Tier, 'tranche_created'>,
  spec: VersionSpec,
): Result<SettingsSeries<Tier, 'tranche_created'>, SettingsRefusalKey> {
  return appendSettingsVersion(series, version(spec));
}

describe('журнал версий дописывается только в конец', () => {
  it('первая версия ложится в пустой журнал', () => {
    const appended = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    expect(appended.value.versions).toHaveLength(1);
    // Прежний журнал не изменился: запись не правит историю.
    expect(EMPTY.versions).toHaveLength(0);
  });

  it('версия чужого домена отвергается', () => {
    const appended = append(EMPTY, {
      id: 'other/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.error).toBe(SETTINGS_REFUSAL_KEYS.versionDomainMismatch);
  });

  it('повтор идентификатора отвергается с названной причиной', () => {
    const first = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = append(first.value, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(2),
      effectiveFrom: at(2),
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toBe(SETTINGS_REFUSAL_KEYS.versionIdReused);
    const stored = findSettingsVersion(first.value, settingsVersionId('probe/2026-09-04.1'));
    expect(stored).not.toBeNull();
  });

  it('идентификатор, не возрастающий, отвергается', () => {
    const first = append(EMPTY, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(1),
      effectiveFrom: at(1),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const back = append(first.value, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(2),
      effectiveFrom: at(2),
    });
    expect(back.ok).toBe(false);
    if (back.ok) return;
    expect(back.error).toBe(SETTINGS_REFUSAL_KEYS.versionIdOutOfOrder);
  });

  it('запись раньше предыдущей отвергается', () => {
    const first = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(10),
      effectiveFrom: at(10),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const earlier = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(5),
      effectiveFrom: at(20),
    });
    expect(earlier.ok).toBe(false);
    if (earlier.ok) return;
    expect(earlier.error).toBe(SETTINGS_REFUSAL_KEYS.versionRecordedOutOfOrder);
  });

  it('две версии на один момент вступления в силу отвергаются', () => {
    // §7.3: правка, сохранённая дважды, не порождает две действующие версии.
    const first = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(5),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const collided = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(1),
      effectiveFrom: at(5),
    });
    expect(collided.ok).toBe(false);
    if (collided.ok) return;
    expect(collided.error).toBe(SETTINGS_REFUSAL_KEYS.versionEffectiveMomentCollides);
  });

  it('версия, действующая раньше уже записанной отложенной, отвергается', () => {
    // Введена позже, а действовать начала бы раньше отложенной. Ф2.1 и §7.3
    // расходятся ровно здесь; до ответа владельца действует строгий вариант.
    const deferred = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(100),
    });
    expect(deferred.ok).toBe(true);
    if (!deferred.ok) return;
    const sooner = append(deferred.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(2),
      effectiveFrom: at(50),
    });
    expect(sooner.ok).toBe(false);
    if (sooner.ok) return;
    expect(sooner.error).toBe(SETTINGS_REFUSAL_KEYS.versionEffectiveBeforeDeferred);
  });

  it('версия, действующая раньше уже действующей, невозможна по построению', () => {
    // Второй половины этого запрета в журнале нет и не нужно: чтобы обогнать
    // действующую версию, новая обязана вступить в силу раньше, чем записана, —
    // а такую не соберёт конструктор (`version.test.ts`).
    const live = append(EMPTY, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(() =>
      version({ id: 'probe/2026-09-04.2', recordedAt: at(10), effectiveFrom: at(1) }),
    ).toThrow();
  });
});

describe('журнал, поднятый из хранилища', () => {
  it('собирается теми же правилами', () => {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>('probe', 'tranche_created', [
      version({ id: 'probe/2026-09-04.1', recordedAt: at(1), effectiveFrom: at(1) }),
      version({ id: 'probe/2026-09-04.2', recordedAt: at(2), effectiveFrom: at(20) }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.versions).toHaveLength(2);
  });

  it('порядок из хранилища проверяется, а не принимается на веру', () => {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>('probe', 'tranche_created', [
      version({ id: 'probe/2026-09-04.2', recordedAt: at(2), effectiveFrom: at(20) }),
      version({ id: 'probe/2026-09-04.1', recordedAt: at(1), effectiveFrom: at(1) }),
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toBe(SETTINGS_REFUSAL_KEYS.versionIdOutOfOrder);
  });
});
