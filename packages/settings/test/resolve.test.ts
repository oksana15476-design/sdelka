import { describe, expect, it } from 'vitest';
import {
  NOT_STICKY,
  SETTINGS_OUTCOME_KEYS,
  SETTINGS_REFUSAL_KEYS,
  type NotSticky,
  type SettingsRefusalKey,
  type SettingsSeries,
  type StickingPoint,
  observationMoment,
  settingsSeries,
  settingsSeriesFromStore,
  stickingMoment,
  versionInEffect,
  versionInEffectNow,
} from '../src/index';
import { type Tier, at, chain, version } from './support/fixtures';

const V1 = version({
  id: 'probe/2026-09-04.1',
  recordedAt: at(10),
  effectiveFrom: at(10),
  supersedes: null,
});
const V2 = version({
  id: 'probe/2026-09-04.2',
  recordedAt: at(20),
  effectiveFrom: at(30),
  supersedes: 'probe/2026-09-04.1',
});

function seriesOf(): SettingsSeries<Tier, 'tranche_created'> {
  const built = settingsSeriesFromStore<Tier, 'tranche_created'>('probe', 'tranche_created', [
    V1,
    V2,
  ]);
  if (!built.ok) throw new Error(built.error);
  return built.value;
}

describe('действующая версия на момент', () => {
  it('пустая история — отказ, а не умолчание', () => {
    // Падает, если пустая история начнёт отвечать успехом: успех с пустым
    // значением вызывающий свернёт в `?? DEFAULT`, и в продукте появится
    // четвёртый тариф — к трём, которые там уже есть (`SETTINGS.md` §10 В1.1).
    const empty = settingsSeries<Tier, 'tranche_created'>('probe', 'tranche_created');
    const resolved = versionInEffect(empty, stickingMoment('tranche_created', at(100)));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('момент раньше первой версии: первая не подставляется, а отказ', () => {
    // История непуста, но на этот момент величины ещё не было. Подставить первую
    // «за неимением лучшего» значит посчитать сделку по версии, принятой после неё.
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(9)));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('момент вступления включительно: ровно в него версия уже действует', () => {
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(10)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.versionId).toBe(V1.versionId);
  });

  it('между версиями действует первая, после второй — вторая', () => {
    const series = seriesOf();
    const between = versionInEffect(series, stickingMoment('tranche_created', at(20)));
    const after = versionInEffect(series, stickingMoment('tranche_created', at(31)));
    expect(between.ok && between.value.applied.versionId).toBe(V1.versionId);
    expect(after.ok && after.value.applied.versionId).toBe(V2.versionId);
  });

  it('прилипание: на момент создания транша берётся версия того момента, а не сегодняшняя', () => {
    // Проверка падает, если резолвер начнёт отвечать «на сейчас»: транш создан
    // до `.2`, и по нему обязана действовать `.1` (`SETTINGS.md` §В1 п.3).
    const resolved = versionInEffect(seriesOf(), stickingMoment('tranche_created', at(12)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.strategy).toBe('sticky');
    expect(resolved.value.applied.versionId).toBe(V1.versionId);
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
        version({
          id: 'probe/2026-09-04.3',
          recordedAt: at(10),
          effectiveFrom: at(10),
          supersedes: 'probe/2026-09-04.1',
        }),
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
        version({
          id: 'probe/2026-09-04.3',
          recordedAt: at(10),
          effectiveFrom: at(10),
          supersedes: 'probe/2026-09-04.1',
        }),
        V2,
      ],
    };
    const resolved = versionInEffect(forgedStore, stickingMoment('tranche_created', at(40)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.versionId).toBe(V2.versionId);
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
    expect(resolved.value.applied.versionId).toBe(V2.versionId);
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

describe('три версии: до, между и после', () => {
  // Ни одной величины: значение — непрозрачная метка. Три версии нужны не ради
  // чисел, а ради двух промежутков — между первой и второй и между второй и
  // третьей: резолвер с одним промежутком проходит и «берём последнюю».
  const LADDER = chain([
    { id: 'probe/2026-09-04.1', recordedAt: at(1), effectiveFrom: at(10) },
    { id: 'probe/2026-09-04.2', recordedAt: at(5), effectiveFrom: at(30) },
    { id: 'probe/2026-09-04.3', recordedAt: at(7), effectiveFrom: at(60) },
  ]);

  function ladder(): SettingsSeries<Tier, 'tranche_created'> {
    const built = settingsSeriesFromStore<Tier, 'tranche_created'>(
      'probe',
      'tranche_created',
      LADDER,
    );
    if (!built.ok) throw new Error(built.error);
    return built.value;
  }

  function idAt(hours: number): string | SettingsRefusalKey {
    const resolved = versionInEffect(ladder(), stickingMoment('tranche_created', at(hours)));
    return resolved.ok ? resolved.value.applied.versionId : resolved.error;
  }

  it('до первой версии — отказ, а не первая «за неимением лучшего»', () => {
    expect(idAt(0)).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
    expect(idAt(9)).toBe(SETTINGS_REFUSAL_KEYS.noVersionInEffect);
  });

  it('между версиями действует та, что вступила в силу последней из наступивших', () => {
    expect(idAt(10)).toBe('probe/2026-09-04.1');
    expect(idAt(20)).toBe('probe/2026-09-04.1');
    expect(idAt(29)).toBe('probe/2026-09-04.1');
    expect(idAt(30)).toBe('probe/2026-09-04.2');
    expect(idAt(45)).toBe('probe/2026-09-04.2');
    expect(idAt(59)).toBe('probe/2026-09-04.2');
    expect(idAt(60)).toBe('probe/2026-09-04.3');
  });

  it('после последней версии действует последняя', () => {
    expect(idAt(100)).toBe('probe/2026-09-04.3');
    expect(idAt(10_000)).toBe('probe/2026-09-04.3');
  });

  it('момент прилипания в прошлом не подтягивает сегодняшнюю версию', () => {
    // Пересчёт задним числом запрещён (`FUNCTIONAL.md` §4.6): транш, созданный в
    // момент 20, живёт по `.1`, сколько бы версий ни легло после него. Проверка
    // падает, если резолвер начнёт отвечать «на сейчас».
    expect(idAt(20)).toBe('probe/2026-09-04.1');
    expect(idAt(100)).toBe('probe/2026-09-04.3');
  });

  it('резолвер — чистая функция: журнала не трогает и отвечает одинаково', () => {
    const series = ladder();
    const first = versionInEffect(series, stickingMoment('tranche_created', at(45)));
    const second = versionInEffect(series, stickingMoment('tranche_created', at(45)));
    expect(first).toEqual(second);
    expect(series.versions).toHaveLength(3);
    expect(series.versions.map((each) => each.versionId)).toEqual(
      LADDER.map((each) => each.versionId),
    );
  });

  it('порядок записей в журнале на ответ не влияет', () => {
    // Так журнал приходит из хранилища, если сортировка потерялась по дороге.
    // Ответ обязан зависеть от истории и момента, а не от места в массиве:
    // проверка падает на реализации «берём последний элемент».
    const shuffled: SettingsSeries<Tier, 'tranche_created'> = {
      domain: ladder().domain,
      attachment: 'tranche_created',
      versions: [LADDER[2], LADDER[0], LADDER[1]].filter(
        (each): each is (typeof LADDER)[number] => each !== undefined,
      ),
    };
    const resolved = versionInEffect(shuffled, stickingMoment('tranche_created', at(45)));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.applied.versionId).toBe('probe/2026-09-04.2');
  });
});
