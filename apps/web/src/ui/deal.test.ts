import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type DealSnapshot, getDeal, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { dictionaryOf } from '@/i18n/translate';
import { formatMoney } from '@/i18n/format';
import { type Locale, LOCALES } from '@/i18n/locales';
import type { L10n } from './l10n';
import { PENDING_LEGAL_SLOTS } from './primitives';
import { MoneyStateCard } from './deal';

/**
 * Карточка «Где мои деньги» — единственное место кабинета, где клиент действует
 * деньгами. Проверяется отрисованная разметка, а не промежуточная функция:
 * дефект `CABINETS-REDESIGN.md` §1.5 жил в подстановке, то есть **между**
 * правильными данными и правильным ключом. Тест на данные его не видел, тест на
 * словарь тоже; увидеть его может только строка, которую читает клиент.
 *
 * JSX здесь не используется намеренно: сборка приложения отдаёт разметку Next
 * (`jsx: preserve`), и тест, требующий собственной настройки трансформации,
 * проверял бы уже не то дерево. `createElement` вызывает ровно ту функцию,
 * которую вызовет сервер.
 */

function l10n(locale: Locale): L10n {
  return { dict: dictionaryOf(locale), locale };
}

function render(l: L10n, deal: DealSnapshot): string {
  return renderToStaticMarkup(
    createElement(MoneyStateCard, {
      l,
      deal,
      now: now(),
      operationsZone: OPERATIONS_TIME_ZONE,
      viewerZone: viewerTimeZone(),
    }),
  );
}

/** Текст кнопки карточки — без разметки и без соседних блоков. */
function ctaText(markup: string): string {
  const match = /<a class="btn[^"]*"[^>]*>(.*?)<\/a>/su.exec(markup);
  return match === undefined || match === null ? '' : (match[1] ?? '').replace(/<[^>]*>/gu, '');
}

async function deal(id: string): Promise<DealSnapshot> {
  const found = await getDeal(id);
  if (found === null) throw new Error(`фикстура ${id} не найдена`);
  return found;
}

describe('M-07: кнопка добора называет недобор, а не сумму сделки', () => {
  it.each(LOCALES)('на %s в кнопку идёт недобор', async (locale) => {
    const m07 = await deal('m07');
    const shortfall = m07.shortfall;
    expect(m07.moneyState).toBe('partiallyFunded');
    expect(shortfall).not.toBeNull();
    if (shortfall === null) return;

    const cta = ctaText(render(l10n(locale), m07));

    // Ради этой пары и написан тест: до правки в кнопке стояла сумма сделки,
    // клиент дослал бы её поверх внесённой, и мы получили бы перебор и ручной
    // возврат вместо закрытого недобора.
    expect(cta).toContain(formatMoney(locale, shortfall));
    expect(cta).not.toContain(formatMoney(locale, m07.required));
  });

  it('недобор — это разница между суммой сделки и тем, что на счёте', async () => {
    const m07 = await deal('m07');
    expect(m07.shortfall?.minor).toBe(m07.required.minor - (m07.credited.minor + m07.locked.minor));
  });

  it('рядом с кнопкой стоят все три числа, из которых получено её число', async () => {
    const m07 = await deal('m07');
    const markup = render(l10n('ru'), m07);
    for (const value of [m07.required, m07.credited, m07.shortfall]) {
      if (value === null) continue;
      // Разметка режет сумму на узлы по частям формата, поэтому сравнение идёт
      // по тексту без тегов — так же, как её видит глаз.
      expect(markup.replace(/<[^>]*>/gu, '')).toContain(formatMoney('ru', value));
    }
  });
});

describe('M-08: излишек назван числом и у него есть путь', () => {
  it('показывает сумму излишка и ссылку на вывод', async () => {
    const m08 = await deal('m08');
    const excess = m08.excess;
    expect(m08.moneyState).toBe('overfunded');
    expect(excess).not.toBeNull();
    if (excess === null) return;
    const markup = render(l10n('ru'), m08);
    expect(markup.replace(/<[^>]*>/gu, '')).toContain(formatMoney('ru', excess));
    expect(markup).toContain('/ru/withdraw');
  });
});

describe('M-06: «забрать можно в любой момент» — с путём к выводу', () => {
  it('обещание на экране сопровождается ссылкой', async () => {
    const m19 = await deal('m19');
    expect(m19.moneyState).toBe('onAccount');
    expect(render(l10n('ru'), m19)).toContain('/ru/withdraw');
  });
});

describe('внутренностей домена на клиентском экране нет', () => {
  it.each(['m07', 'm09', 'm13', 'm18'])('%s: имён нашей машины в разметке нет', async (id) => {
    const snapshot = await deal(id);
    const markup = render(l10n('ru'), snapshot);
    expect(snapshot.moneyStateCode).toMatch(/^M-\d\d$/u);
    expect(markup).not.toContain(snapshot.moneyStateCode);
    expect(markup).not.toContain(snapshot.trancheStatus);
    expect(markup).not.toContain(snapshot.moneyState);
  });
});

describe('⚖-слот без формулировки юриста молчит', () => {
  it.each(LOCALES)('M-13 на %s не показывает ни черновика, ни нашей пометки', async (locale) => {
    const m13 = await deal('m13');
    const l = l10n(locale);
    expect(m13.moneyState).toBe('payoutUnknown');
    const markup = render(l, m13);
    expect(markup).not.toContain(l.dict['legal.pending.label']);
    expect(markup).not.toContain(l.dict['legal.pending.body']);
    expect(markup).not.toContain('legal--pending');
    // И пустой рамки на месте слота тоже не остаётся.
    expect(markup).not.toContain('state-card__section"></div>');
  });

  it('незакрытые слоты перечислены поимённо, и ни в одном словаре их нет', () => {
    expect(PENDING_LEGAL_SLOTS.length).toBeGreaterThan(0);
    for (const key of PENDING_LEGAL_SLOTS) {
      for (const locale of LOCALES) {
        expect(dictionaryOf(locale)[key]).toBeUndefined();
      }
    }
  });

  it('слот с формулировкой, прошедшей ревью, показывается', async () => {
    const m09 = await deal('m09');
    const l = l10n('ru');
    const wording = l.dict['deal.paying.where.reserved.revocation'];
    expect(wording).toBeDefined();
    expect(render(l, m09)).toContain(wording);
  });
});
