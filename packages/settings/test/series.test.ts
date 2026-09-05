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
import { type Tier, type VersionSpec, at, chain, version } from './support/fixtures';

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
      supersedes: null,
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
      supersedes: null,
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
      supersedes: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = append(first.value, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(2),
      effectiveFrom: at(2),
      supersedes: null,
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
      supersedes: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const back = append(first.value, {
      id: 'probe/2026-09-04.1',
      recordedAt: at(2),
      effectiveFrom: at(2),
      supersedes: null,
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
      supersedes: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const earlier = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(5),
      effectiveFrom: at(20),
      supersedes: null,
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
      supersedes: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const collided = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(1),
      effectiveFrom: at(5),
      supersedes: null,
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
      supersedes: null,
    });
    expect(deferred.ok).toBe(true);
    if (!deferred.ok) return;
    const sooner = append(deferred.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(2),
      effectiveFrom: at(50),
      supersedes: null,
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
      supersedes: null,
    });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    expect(() =>
      version({
        id: 'probe/2026-09-04.2',
        recordedAt: at(10),
        effectiveFrom: at(1),
        supersedes: 'probe/2026-09-04.1',
      }),
    ).toThrow();
  });
});

describe('цепочка версий не рвётся', () => {
  const FIRST: VersionSpec = {
    id: 'probe/2026-09-04.1',
    recordedAt: at(1),
    effectiveFrom: at(1),
    supersedes: null,
  };

  it('первая версия ссылается на предыдущую, которой нет, — отказ', () => {
    // Падает без проверки: журнал пуст, ссылаться не на что, и «предыдущая»
    // указывала бы на запись, которой в этой истории никогда не было.
    const appended = append(EMPTY, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(1),
      effectiveFrom: at(1),
      supersedes: 'probe/2026-09-04.1',
    });
    expect(appended.ok).toBe(false);
    if (appended.ok) return;
    expect(appended.error).toBe(SETTINGS_REFUSAL_KEYS.versionSupersedesUnexpected);
  });

  it('вторая версия без ссылки — отказ: разрыв цепочки', () => {
    const first = append(EMPTY, FIRST);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const orphan = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(2),
      effectiveFrom: at(20),
      supersedes: null,
    });
    expect(orphan.ok).toBe(false);
    if (orphan.ok) return;
    expect(orphan.error).toBe(SETTINGS_REFUSAL_KEYS.versionSupersedesMissing);
  });

  it('ссылка через голову последней записи — отказ', () => {
    // `.3` ссылается на `.1`, минуя `.2`. Так в журнале появляется развилка:
    // две версии называют своей предыдущей одну и ту же, и «что действовало
    // после `.1`» перестаёт иметь единственный ответ.
    const first = append(EMPTY, FIRST);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = append(first.value, {
      id: 'probe/2026-09-04.2',
      recordedAt: at(2),
      effectiveFrom: at(20),
      supersedes: 'probe/2026-09-04.1',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const forked = append(second.value, {
      id: 'probe/2026-09-04.3',
      recordedAt: at(3),
      effectiveFrom: at(30),
      supersedes: 'probe/2026-09-04.1',
    });
    expect(forked.ok).toBe(false);
    if (forked.ok) return;
    expect(forked.error).toBe(SETTINGS_REFUSAL_KEYS.versionSupersedesNotPrevious);
  });

  it('связная цепочка ложится в журнал', () => {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>(
      'probe',
      'tranche_created',
      chain([
        { id: 'probe/2026-09-04.1', recordedAt: at(1), effectiveFrom: at(1) },
        { id: 'probe/2026-09-04.2', recordedAt: at(2), effectiveFrom: at(20) },
        { id: 'probe/2026-09-04.3', recordedAt: at(3), effectiveFrom: at(30) },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const links = built.value.versions.map((each) => each.supersedes);
    expect(links).toEqual([null, 'probe/2026-09-04.1', 'probe/2026-09-04.2']);
  });
});

describe('журнал, поднятый из хранилища', () => {
  it('собирается теми же правилами', () => {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>(
      'probe',
      'tranche_created',
      chain([
        { id: 'probe/2026-09-04.1', recordedAt: at(1), effectiveFrom: at(1) },
        { id: 'probe/2026-09-04.2', recordedAt: at(2), effectiveFrom: at(20) },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.versions).toHaveLength(2);
  });

  it('порядок из хранилища проверяется, а не принимается на веру', () => {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>('probe', 'tranche_created', [
      version({
        id: 'probe/2026-09-04.2',
        recordedAt: at(2),
        effectiveFrom: at(20),
        supersedes: null,
      }),
      version({
        id: 'probe/2026-09-04.1',
        recordedAt: at(1),
        effectiveFrom: at(1),
        supersedes: null,
      }),
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toBe(SETTINGS_REFUSAL_KEYS.versionIdOutOfOrder);
  });
});
