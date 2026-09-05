import { describe, expect, it } from 'vitest';
import { GUARD_IDS, WITHDRAWAL_GUARD_IDS } from '@sdelka/domain';
import { MONEY_STATES } from '@/view/money-state';
import { type RequiredAction, requiredAction } from '@/view/action';
import type { DealRole } from '@/fixtures/scenarios';
import type { DealSnapshot } from '@/fixtures/store';
import { GUARD_LABEL_KEY } from '@/ui/guards';
import { type Locale, LOCALES, localePath } from './locales';
import { dictionaryOf, plural, t } from './translate';
import { formatArea, formatNumber } from './format';

/**
 * Три языка — правило, а не намерение (`CLAUDE.md`, «Три языка»).
 *
 * Все проверки здесь — про то, чего **не видит обход интерфейса**: он ходит по
 * маршрутам, а дефект живёт в сочетании, до которого фикстура не доводит.
 * Ровно так пережили аудит четыре из десяти находок: ключ, собранный шаблоном
 * из имени домена; ветка роли, до которой не доходит ни один снимок; вид записи
 * журнала, которого нет в фикстуре. Ключ, собранный в момент отрисовки, ни
 * `tsc`, ни обход не ловят — ловит только перебор.
 */

const DICTS = Object.fromEntries(LOCALES.map((locale) => [locale, dictionaryOf(locale)])) as Record<
  Locale,
  ReturnType<typeof dictionaryOf>
>;

/** Ключ, которого нет, `t` возвращает меткой `[ключ]` — по ней и ищем. */
function resolves(key: string): boolean {
  return LOCALES.every((locale) => !t(DICTS[locale], key).startsWith('['));
}

describe('подписи guard’ов консоли', () => {
  it('каждое имя guard’а домена имеет ключ, а ключ — перевод на трёх языках', () => {
    const ids = [...new Set([...GUARD_IDS, ...WITHDRAWAL_GUARD_IDS])];
    expect(ids.length).toBe(23);
    for (const id of ids) {
      const key = GUARD_LABEL_KEY[id];
      expect(key, `нет ключа у ${id}`).toBeTypeOf('string');
      expect(resolves(key), `нет перевода у ${key} (${id})`).toBe(true);
    }
  });

  it('в карте нет ключей сверх имён домена: мёртвая подпись — тоже расхождение', () => {
    const ids = new Set<string>([...GUARD_IDS, ...WITHDRAWAL_GUARD_IDS]);
    for (const id of Object.keys(GUARD_LABEL_KEY)) expect(ids.has(id)).toBe(true);
  });

  /**
   * Ключ равен `ops.guard.<имя>` у всех, кроме одного: у единственного guard'а,
   * в чьём имени стоит ролевое название стороны, ключ назван словарём продукта
   * (`ui/guards.ts`, шапка). Расхождение проверяется поимённо, чтобы второе,
   * заведённое молча, было видно здесь, а не на четырёхминутном обходе.
   */
  it('имя и ключ расходятся ровно у одного guard’а, и он назван', () => {
    const renamed = Object.entries(GUARD_LABEL_KEY).filter(
      ([id, key]) => key !== `ops.guard.${id}`,
    );
    expect(renamed).toEqual([['g_owner_is_buyer', 'ops.guard.g_owner_is_paying_party']]);
  });

  it('исход пройдено/не пройдено имеет текст, а не только цвет точки', () => {
    expect(resolves('ops.guard.state.passed')).toBe(true);
    expect(resolves('ops.guard.state.failed')).toBe(true);
  });
});

describe('требуемое действие по сделке', () => {
  const ROLES: readonly DealRole[] = ['paying', 'receiving'];

  /**
   * `requiredAction` собирает ключи шаблоном `deal.<роль>.action.<хвост>`, то
   * есть ключ существует только в момент вызова. Перебор ролей, положений денег
   * и двух модификаторов — единственный способ узнать, что все они есть в
   * словаре: сборка о шаблонном ключе не знает ничего.
   */
  function snapshot(
    role: DealRole,
    moneyState: (typeof MONEY_STATES)[number],
    hasMismatch: boolean,
    quoteExpired: boolean,
  ): DealSnapshot {
    return {
      role,
      moneyState,
      property: { hasMismatch },
      modifiers: { quoteExpired },
    } as unknown as DealSnapshot;
  }

  it('каждый ключ, который может вернуть requiredAction, есть на трёх языках', () => {
    const missing: string[] = [];
    for (const role of ROLES) {
      for (const moneyState of MONEY_STATES) {
        for (const hasMismatch of [false, true]) {
          for (const quoteExpired of [false, true]) {
            const action: RequiredAction = requiredAction(
              snapshot(role, moneyState, hasMismatch, quoteExpired),
            );
            const keys = [action.titleKey, action.ctaKey, action.secondaryCtaKey, action.reasonKey];
            for (const key of keys) {
              if (key === null) continue;
              if (!resolves(key)) missing.push(`${role}/${moneyState}: ${key}`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('получающей стороне при расхождении подписывается её действие, а не пополнение', () => {
    const action = requiredAction(snapshot('receiving', 'notFunded', true, false));
    expect(action.kind).toBe('blocked');
    expect(action.ctaKey).toBe('deal.receiving.action.submitDocuments.cta');
  });
});

describe('переключатель языка', () => {
  it('оставляет пользователя на том же экране', () => {
    expect(localePath('/ru/deals/m11', 'ka')).toBe('/ka/deals/m11');
    expect(localePath('/ru/ops/task/t-01', 'en')).toBe('/en/ops/task/t-01');
  });

  it('корень остаётся корнем, а путь без языка ведёт в корень', () => {
    expect(localePath('/ru', 'en')).toBe('/en');
    expect(localePath('/deals/m11', 'en')).toBe('/en');
  });
});

describe('формы множественного числа', () => {
  /**
   * В русском форм четыре, в грузинском одна. Выбирает их `Intl.PluralRules`,
   * а не условие в коде: тест сравнивает выбор с формами словаря, а не с
   * ожиданием, выписанным от руки рядом.
   */
  it('русский различает 1, 2 и 5', () => {
    const dict = DICTS.ru;
    expect(plural(dict, 'ru', 'deals.count', 1)).toBe(dict['deals.count.one']?.replace('{count}', '1'));
    expect(plural(dict, 'ru', 'deals.count', 2)).toBe(dict['deals.count.few']?.replace('{count}', '2'));
    expect(plural(dict, 'ru', 'deals.count', 5)).toBe(dict['deals.count.many']?.replace('{count}', '5'));
  });

  it('само число печатается локалью, а не приведением к строке', () => {
    expect(plural(DICTS.ru, 'ru', 'deals.count', 1234)).toContain(formatNumber('ru', 1234));
    expect(plural(DICTS.ru, 'ru', 'deals.count', 1234)).not.toContain('1234');
  });

  it('счётные подписи имеют все четыре формы на трёх языках', () => {
    const bases = [
      'deals.count',
      'owner.deals.count',
      'owner.limits.count',
      'ops.queue.count',
      'owner.row.averageDeal',
      'ops.metric.withoutHuman.note',
      'ops.duty.withoutDeadline.note',
    ];
    for (const base of bases) {
      for (const form of ['one', 'few', 'many', 'other']) {
        expect(resolves(`${base}.${form}`), `${base}.${form}`).toBe(true);
      }
    }
  });
});

describe('числа вне денег', () => {
  it('площадь идёт через Intl и сохраняет знак после запятой', () => {
    expect(formatArea('ru', '92.0')).toBe('92,0');
    expect(formatArea('en', '92.0')).toBe('92.0');
    expect(formatArea('ka', '89.6')).toBe('89,6');
  });

  /**
   * Ожидание строится тем же `Intl`, а не выписывается рядом от руки: разделитель
   * разрядов в русской локали — неразрывный пробел, и записанный в тесте обычный
   * пробел даёт красную проверку на верном коде. Проверяется здесь **не значение
   * разделителя**, а то, что разряды не потерялись и знаки после запятой на месте.
   */
  it('площадь не теряет разрядов на большом объекте', () => {
    const expected = new Intl.NumberFormat('ru-RU', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    }).format(1234.05);
    expect(formatArea('ru', '1234.05')).toBe(expected);
  });
});
