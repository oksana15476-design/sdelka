import { describe, expect, it } from 'vitest';
import {
  NOT_STICKY,
  SETTINGS_OUTCOME_KEYS,
  SETTINGS_REFUSAL_KEYS,
  type NotSticky,
  type SettingsSeries,
  type StickingPoint,
  observationMoment,
  settingsSeries,
  settingsSeriesFromStore,
  stickingMoment,
  versionInEffect,
  versionInEffectNow,
} from '../src/index';
import { type Tier, at, version } from './support/fixtures';

const V1 = version({ id: 'probe/2026-09-04.1', recordedAt: at(10), effectiveFrom: at(10) });
const V2 = version({ id: 'probe/2026-09-04.2', recordedAt: at(20), effectiveFrom: at(30) });

function seriesOf(): SettingsSeries<Tier, 'tranche_created'> {
  const built = settingsSeriesFromStore<Tier, 'tranche_created'>('probe', 'tranche_created', [
    V1,
    V2,
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

describe('действующая версия на момент', () => {
  it('версий нет вовсе: ответ — «действующей версии нет», а не умолчание', () => {
    const empty = settingsSeries<Tier, 'tranche_created'>('probe', 'tranche_created');
    const resolved = versionInEffect(empty, stickingMoment('tranche_created', at(100)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied).toBeNull();
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.noVersionInEffect);
  });

  it('момент раньше первой версии: первая не подставляется', () => {
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(9)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied).toBeNull();
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.noVersionInEffect);
  });

  it('момент вступления включительно: ровно в него версия уже действует', () => {
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(10)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied?.versionId).toBe(V1.versionId);
  });

  it('между версиями действует первая, после второй — вторая', () => {
    const series = seriesOf();
    const between = versionInEffect(series, stickingMoment('tranche_created', at(20)));
    const after = versionInEffect(series, stickingMoment('tranche_created', at(31)));
    expect(between.ok && between.value.applied?.versionId).toBe(V1.versionId);
    expect(after.ok && after.value.applied?.versionId).toBe(V2.versionId);
  });

  it('прилипание: на момент создания транша берётся версия того момента, а не сегодняшняя', () => {
    // Проверка падает, если резолвер начнёт отвечать «на сейчас»: транш создан
    // до `.2`, и по нему обязана действовать `.1` (`SETTINGS.md` §В1 п.3).
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(12)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.strategy).toBe('sticky');
    expect(resolved.value.applied?.versionId).toBe(V1.versionId);
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.stickyVersionApplied);
  });

  it('две версии на один момент: разрешение отказывает, а не выбирает молча', () => {
    // Журнал такой пары не примет; сюда она попадает из хранилища мимо записи —
    // типы не переживают границу процесса.
    const forgedStore: SettingsSeries<Tier, 'tranche_created'> = {
      domain: seriesOf().domain,
      attachment: 'tranche_created',
      versions: [
        V1,
        version({ id: 'probe/2026-09-04.3', recordedAt: at(10), effectiveFrom: at(10) }),
      ],
    };
    const resolved = versionInEffect(forgedStore, stickingMoment('tranche_created', at(15)));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.effectiveMomentAmbiguous);
  });

  it('совпадение моментов ниже действующего разрешению не мешает', () => {
    const forgedStore: SettingsSeries<Tier, 'tranche_created'> = {
      domain: seriesOf().domain,
      attachment: 'tranche_created',
      versions: [
        V1,
        version({ id: 'probe/2026-09-04.3', recordedAt: at(10), effectiveFrom: at(10) }),
        V2,
      ],
    };
    const resolved = versionInEffect(forgedStore, stickingMoment('tranche_created', at(40)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied?.versionId).toBe(V2.versionId);
  });
});

describe('момент прилипания — не «сейчас», и это проверяет компилятор', () => {
  it('величину с прилипанием нельзя спросить «на сейчас»', () => {
    const series = seriesOf();
    // @ts-expect-error — журнал прилипает к созданию транша: «версия на сейчас»
    // у него не спрашивается (`SETTINGS.md` §2.1, §7.1).
    const resolved = versionInEffectNow(series, observationMoment(at(100)));
    // Рантайм-рубеж на случай, когда журнал пришёл из хранилища с широким типом.
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  });

  it('момент чужого события не принимается', () => {
    const series = seriesOf();
    // @ts-expect-error — выпуск котировки не тот момент, к которому привязан журнал.
    const resolved = versionInEffect(series, stickingMoment('quote_issued', at(100)));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  });

  it('журнал с широким типом момента компилятором не ловится — ловится рантаймом', () => {
    // Так журнал приходит из хранилища: момент прилипания в нём строка, а не литерал.
    const wide: SettingsSeries<Tier, StickingPoint> = {
      domain: seriesOf().domain,
      attachment: 'tranche_created',
      versions: [V1],
    };
    const resolved = versionInEffect(wide, stickingMoment('quote_issued', at(100)));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.attachmentMismatch);
  });
});

describe('величина, которая не прилипает', () => {
  it('разрешается на момент наблюдения и говорит об этом ключом', () => {
    const built = settingsSeriesFromStore<Tier, NotSticky>('probe', NOT_STICKY, [V1, V2]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const resolved = versionInEffectNow(built.value, observationMoment(at(40)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.strategy).toBe('immediate');
    expect(resolved.value.applied?.versionId).toBe(V2.versionId);
    expect(resolved.value.reasonKey).toBe(SETTINGS_OUTCOME_KEYS.immediateVersionApplied);
  });

  it('её нельзя спросить «на момент прилипания»', () => {
    const built = settingsSeriesFromStore<Tier, NotSticky>('probe', NOT_STICKY, [V1]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // @ts-expect-error — у величины нет момента прилипания: спрашивать «на момент
    // создания транша» у окна наблюдения нечего (`SETTINGS.md` §В6 п.3).
    const resolved = versionInEffect(built.value, stickingMoment('tranche_created', at(40)));
    expect(resolved.ok).toBe(false);
  });
});
