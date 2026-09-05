import { describe, expect, it } from 'vitest';
import {
  SettingsError,
  SettingsErrorCode,
  type SettingsVersion,
  compareVersionIds,
  settingsReasonKey,
  settingsVersion,
  settingsVersionDomain,
  settingsVersionId,
} from '../src/index';
import {
  OPERATOR_ROLE,
  OWNER,
  OWNER_ROLE,
  REASON,
  type Tier,
  at,
  version,
} from './support/fixtures';

describe('идентификатор версии', () => {
  it('домен читается из идентификатора', () => {
    expect(settingsVersionDomain(settingsVersionId('probe/2026-09-04.1'))).toBe('probe');
  });

  it('форма без домена, без даты или без порядкового не принимается', () => {
    const bads = ['2026-09-04.1', 'probe/2026-09-04', 'probe/20260904.1', 'Probe/2026-09-04.1'];
    for (const bad of bads) {
      expect(() => settingsVersionId(bad)).toThrow(SettingsError);
    }
  });

  it('дата, которой нет в календаре, не принимается', () => {
    // Форме `\d{4}-\d{2}-\d{2}` она соответствует, и без разбора даты прошла бы.
    for (const bad of ['probe/2026-02-30.1', 'probe/2026-13-01.1']) {
      const thrown = (): unknown => settingsVersionId(bad);
      expect(thrown).toThrow(SettingsError);
      try {
        thrown();
      } catch (error) {
        expect((error as SettingsError).code).toBe(SettingsErrorCode.versionIdDateInvalid);
      }
    }
  });

  it('порядковый с ведущим нулём и нулевой порядковый не принимаются', () => {
    // `.01` и `.1` были бы двумя ключами одной версии — двойное сохранение §7.3.
    expect(() => settingsVersionId('probe/2026-09-04.01')).toThrow(SettingsError);
    expect(() => settingsVersionId('probe/2026-09-04.0')).toThrow(SettingsError);
  });

  it('десятая версия за день старше второй: порядковый числовой, а не строковый', () => {
    // Спека обещает лексикографическую сортировку (§2). Проверка её опровергает:
    // '.10' < '.2' как строки, и журнал бы перевернулся на десятой правке за день.
    const second = settingsVersionId('probe/2026-09-04.2');
    const tenth = settingsVersionId('probe/2026-09-04.10');
    expect(tenth < second).toBe(true);
    expect(compareVersionIds(tenth, second)).toBe(1);
  });

  it('дата старше порядкового при сравнении', () => {
    const earlier = settingsVersionId('probe/2026-09-04.9');
    const later = settingsVersionId('probe/2026-09-05.1');
    expect(compareVersionIds(earlier, later)).toBe(-1);
    expect(compareVersionIds(later, earlier)).toBe(1);
    expect(compareVersionIds(later, later)).toBe(0);
  });
});

describe('основание — ключ, а не текст', () => {
  it('свободный текст ключом не является', () => {
    const bads = ['подняли ставку', 'settings.reason.Подняли', 'reason.owner_decision', ''];
    for (const bad of bads) {
      expect(() => settingsReasonKey(bad)).toThrow(SettingsError);
    }
  });

  it('ключ формы `settings.reason.<снейк>` принимается', () => {
    const key = 'settings.reason.owner_decision';
    expect(settingsReasonKey(key)).toBe(key);
  });
});

describe('версия задним числом не вводится', () => {
  it('момент вступления раньше момента записи — отказ конструктора', () => {
    const build = (): SettingsVersion<Tier> =>
      version({
        id: 'probe/2026-09-04.1',
        recordedAt: at(10),
        effectiveFrom: at(9),
        supersedes: null,
      });
    expect(build).toThrow(SettingsError);
    try {
      build();
    } catch (error) {
      expect((error as SettingsError).code).toBe(SettingsErrorCode.versionBackdated);
    }
  });

  it('вступление в тот же момент — законно: «вступает сейчас»', () => {
    const built = version({
      id: 'probe/2026-09-04.1',
      recordedAt: at(10),
      effectiveFrom: at(10),
      supersedes: null,
    });
    expect(built.effectiveFrom).toBe(built.recordedAt);
  });

  it('отложенное вступление — законно: срок предуведомления это значение поля, а не код', () => {
    const built = version({
      id: 'probe/2026-09-04.1',
      recordedAt: at(10),
      effectiveFrom: at(730),
      supersedes: null,
    });
    expect(built.effectiveFrom).toBeGreaterThan(built.recordedAt);
  });

  /**
   * Компиляционная проверка: запрет «задним числом» стоит в конструкторе, и
   * обойти его сборкой версии литералом нельзя — марка `versionBrand` не
   * ставится ничем, кроме `settingsVersion`. Без марки эта проверка молчала бы,
   * а запрет держался бы на дисциплине вызывающего.
   */
  it('версия не собирается литералом мимо конструктора', () => {
    // @ts-expect-error — литерал не несёт марки конструктора: собрать версию,
    // не пройдя запрет «задним числом», нельзя.
    const forged: SettingsVersion<Tier> = {
      versionId: settingsVersionId('probe/2026-09-04.1'),
      value: 'soft',
      introducedBy: OWNER,
      introducedByRole: OWNER_ROLE,
      reasonKey: REASON,
      recordedAt: at(10),
      effectiveFrom: at(1),
      supersedes: null,
    };
    expect(forged.effectiveFrom).toBeLessThan(forged.recordedAt);
  });
});

describe('кто вправе вводить версию', () => {
  it('роль без `manage_settings` версию не заводит', () => {
    const build = (): SettingsVersion<Tier> =>
      version({
        id: 'probe/2026-09-04.1',
        recordedAt: at(1),
        effectiveFrom: at(1),
        supersedes: null,
        role: OPERATOR_ROLE,
      });
    expect(build).toThrow(SettingsError);
    try {
      build();
    } catch (error) {
      expect((error as SettingsError).code).toBe(SettingsErrorCode.capabilityNotGranted);
    }
  });

  it('владелец заводит, и роль остаётся в записи', () => {
    const built = version({
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
      supersedes: null,
    });
    expect(built.introducedByRole).toBe(OWNER_ROLE);
    expect(built.introducedBy).toBe(OWNER);
    expect(built.reasonKey).toBe(REASON);
  });

  it('версия заморожена: правка вместо новой версии не проходит', () => {
    const built = version({
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
      supersedes: null,
    });
    expect(Object.isFrozen(built)).toBe(true);
  });
});

describe('ссылка на предыдущую версию', () => {
  function codeOf(build: () => unknown): unknown {
    try {
      build();
    } catch (error) {
      return (error as SettingsError).code;
    }
    return null;
  }

  it('первая версия ссылается в никуда — и говорит это словом `null`', () => {
    const built = version({
      id: 'probe/2026-09-04.1',
      recordedAt: at(1),
      effectiveFrom: at(1),
      supersedes: null,
    });
    expect(built.supersedes).toBeNull();
  });

  it('ссылка сохраняется на версии, а не выводится при чтении', () => {
    // Через два года «что было до» обязано читаться из самой записи: журнал
    // может прийти из хранилища частями, и порядок массива фактом не является.
    const built = version({
      id: 'probe/2026-09-04.2',
      recordedAt: at(2),
      effectiveFrom: at(2),
      supersedes: 'probe/2026-09-04.1',
    });
    expect(built.supersedes).toBe('probe/2026-09-04.1');
  });

  it('версия, ссылающаяся сама на себя, не собирается', () => {
    // Падает без проверки: петля вместо цепочки, и «что действовало до» по ней
    // не восстанавливается никогда.
    expect(
      codeOf(() =>
        version({
          id: 'probe/2026-09-04.2',
          recordedAt: at(2),
          effectiveFrom: at(2),
          supersedes: 'probe/2026-09-04.2',
        }),
      ),
    ).toBe(SettingsErrorCode.supersedesSelfReference);
  });

  it('ссылка в чужой домен не собирается', () => {
    // `SETTINGS.md` §9 п.5: тариф не сменяет наценку.
    expect(
      codeOf(() =>
        version({
          id: 'probe/2026-09-04.2',
          recordedAt: at(2),
          effectiveFrom: at(2),
          supersedes: 'other/2026-09-04.1',
        }),
      ),
    ).toBe(SettingsErrorCode.supersedesDomainMismatch);
  });

  it('ссылка вперёд не собирается', () => {
    // Предыдущая версия обязана быть старше по идентификатору — иначе журнал
    // перестаёт сортироваться собственным ключом.
    expect(
      codeOf(() =>
        version({
          id: 'probe/2026-09-04.2',
          recordedAt: at(2),
          effectiveFrom: at(2),
          supersedes: 'probe/2026-09-05.1',
        }),
      ),
    ).toBe(SettingsErrorCode.supersedesNotOlder);
  });

  it('ссылку нельзя не назвать вовсе: пропуск поля версией не становится', () => {
    // Первый рубеж — компилятор, второй — конструктор: версия собирается и из
    // того, что пришло из хранилища, где поля может не быть вовсе.
    expect(() =>
      // @ts-expect-error — `supersedes` обязателен: «первая в журнале» пишется
      // словом `null`, а не молчанием. Пропуск поля и первая версия иначе были бы
      // одним и тем же.
      settingsVersion<Tier>({
        versionId: settingsVersionId('probe/2026-09-04.1'),
        value: 'soft',
        introducedBy: OWNER,
        introducedByRole: OWNER_ROLE,
        reasonKey: REASON,
        recordedAt: at(1),
        effectiveFrom: at(1),
      }),
    ).toThrow(SettingsError);
  });
});
