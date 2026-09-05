/**
 * Тест на саму проверку запрещённой лексики.
 *
 * Проверка, которую никто не проверял, — это не защита, а её обещание. Здесь два
 * требования: она **обязана падать** на подсунутом запрещённом слове и **обязана
 * проходить** на отгруженных словарях. Настоящие словари при этом только
 * читаются: подставные слова живут во временных объектах в памяти, потому что
 * тест, который правит `src/i18n/messages/*.json`, однажды не откатит правку.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  ALLOWANCES,
  LEXICON,
  LOCALES,
  formatFinding,
  scanDictionaries,
  validateAllowances,
} from './forbidden-lexicon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES = resolve(HERE, '..', 'src', 'i18n', 'messages');

function shipped() {
  const dicts = {};
  for (const locale of LOCALES) {
    dicts[locale] = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8'));
  }
  return dicts;
}

/** Словарь из одной строки: минимум, на котором видно поведение правила. */
function dict(key, values) {
  const out = {};
  for (const locale of LOCALES) out[locale] = { [key]: values[locale] ?? 'ok' };
  return out;
}

const banned = (result) => result.findings.filter((finding) => finding.tier === 'banned');

describe('перечень запретов', () => {
  it('каждое правило несёт ссылку на документ и причину', () => {
    for (const rule of LEXICON) {
      expect(rule.source, rule.id).toBeTruthy();
      expect(rule.why.length, rule.id).toBeGreaterThan(20);
      expect(rule.patterns.length, rule.id).toBeGreaterThan(0);
      expect(['banned', 'open'], rule.id).toContain(rule.tier);
      expect(['all', 'client'], rule.id).toContain(rule.scope);
    }
  });

  it('правило «ждёт решения» обязано называть вопрос, на который отвечает человек', () => {
    for (const rule of LEXICON.filter((item) => item.tier === 'open')) {
      expect(rule.question, rule.id).toBeTruthy();
    }
  });

  it('исключение без причины и без ссылки — не исключение', () => {
    expect(validateAllowances()).toEqual([]);
    const problems = validateAllowances(LEXICON, [
      { rule: 'guarantee', key: 'some.key' },
      { rule: 'нет-такого-правила', key: 'some.key', why: 'причина длиной больше двадцати знаков', source: 'X' },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('без причины');
    expect(problems.join(' ')).toContain('без ссылки');
    expect(problems.join(' ')).toContain('правила с таким id нет');
  });
});

describe('проверка падает на подсунутом слове', () => {
  it('ловит запрещённое слово в каждом из трёх языков', () => {
    const planted = dict('assurance.whereMoney.title', {
      ru: 'Деньги на эскроу-счёте',
      en: 'Money in an escrow account',
      ka: 'ფული ესქრო ანგარიშზე',
    });
    const found = banned(scanDictionaries(planted));
    expect(found.map((finding) => finding.locale).sort()).toEqual(['en', 'ka', 'ru']);
    expect(found.every((finding) => finding.ruleId === 'escrow')).toBe(true);
  });

  it('ловит подстроку внутри слова и написание с заглавной', () => {
    for (const value of ['Эскроу', 'ЭСКРОУ', 'предэскроуный', 'Escrow', 'ESCROW', 'eskrou']) {
      const found = banned(scanDictionaries(dict('trust.weDo.1', { ru: value })));
      expect(found, value).toHaveLength(1);
    }
  });

  it('ловит «гарантируем» и не спотыкается о регистр', () => {
    const found = banned(scanDictionaries(dict('trust.weDo.1', {
      ru: 'Гарантируем расчёт',
      en: 'We guarantee the settlement',
      ka: 'ჩვენ ვიძლევით გარანტიას',
    })));
    expect(found).toHaveLength(3);
    expect(found.every((finding) => finding.ruleId === 'guarantee')).toBe(true);
  });

  it('ловит грузинское написание в русском словаре и латинское в грузинском', () => {
    // Так это и попадёт: переводчик копирует строку из соседнего файла.
    const leaked = banned(scanDictionaries({
      ru: { 'trust.weDo.1': 'ესქრო ანგარიში' },
      en: {},
      ka: { 'trust.weDo.1': 'escrow account' },
    }));
    expect(leaked.map((finding) => finding.locale).sort()).toEqual(['ka', 'ru']);
  });

  it('ловит метафору и обещание, а не только два главных слова', () => {
    const cases = {
      metaphor: 'Деньги не пропадут: они под замком.',
      ourMoney: 'Ваши деньги у нас на счёте.',
      discretion: 'Расчёт исполним, когда сочтём условия выполненными.',
      weTransferToSeller: 'Мы переведём продавцу всю сумму.',
      instantPromise: 'Расчёт проходит мгновенно.',
      accessRefusal: 'Недостаточно прав.',
      absoluteSafety: 'Полная защита сделки.',
      irrevocable: 'Средства заблокированы безотзывно.',
      bankProductAccount: 'Деньги на гарантийном счёте.',
      favour: 'В порядке исключения продлим срок.',
      tone: 'К сожалению, платёж не прошёл.',
      legalCheck: 'Юридическая проверка объекта пройдена.',
    };
    for (const [ruleId, value] of Object.entries(cases)) {
      const found = banned(scanDictionaries(dict('trust.weDo.1', { ru: value })));
      expect(found.map((finding) => finding.ruleId), value).toContain(ruleId);
    }
  });

  it('сообщение называет ключ, язык и слово', () => {
    const found = banned(scanDictionaries(dict('deal.paying.where.reserved.title', {
      ru: 'Средства безотзывно заблокированы',
    })));
    const message = formatFinding(found[0]);
    expect(message).toContain('ru:');
    expect(message).toContain('deal.paying.where.reserved.title');
    expect(message).toContain('безотзывно');
  });

  it('красная линия №10 действует и в консоли операций, а правила клиентского текста — нет', () => {
    const inOps = scanDictionaries({
      ru: { 'ops.money.reserved.note': 'Эскроу-счёт, обычно один день' },
      en: {},
      ka: {},
    });
    expect(banned(inOps).map((finding) => finding.ruleId)).toEqual(['escrow']);
    expect(inOps.findings.some((finding) => finding.ruleId === 'foreignDeadline')).toBe(false);
  });

  it('правила «ждёт решения» не считаются падением', () => {
    const result = scanDictionaries(dict('deal.paying.where.transferDeclared.body', {
      ru: 'Обычно зачисление занимает один банковский день.',
    }));
    expect(banned(result)).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['foreignDeadline']);
  });
});

describe('исключения', () => {
  it('разрешают слово только в названном ключе и только по названной причине', () => {
    const allowed = scanDictionaries(dict('assurance.ladder.note', {
      ru: 'Это не гарантия платежа.',
      en: 'This is not a payment guarantee.',
      ka: 'ეს გადახდის გარანტია არ არის.',
    }));
    expect(banned(allowed)).toEqual([]);

    const sameWordElsewhere = scanDictionaries(dict('trust.weDo.1', {
      ru: 'Это не гарантия платежа.',
    }));
    expect(banned(sameWordElsewhere)).toHaveLength(1);
  });

  it('исключение, которое ничего не разрешает, названо мёртвым', () => {
    const result = scanDictionaries(dict('trust.weDo.1', { ru: 'ok' }), {
      allowances: [
        {
          rule: 'guarantee',
          key: 'assurance.ladder.note',
          why: 'причина длиной заведомо больше двадцати знаков',
          source: 'DRAFT-trust.md §7',
        },
      ],
    });
    expect(result.unusedAllowances).toHaveLength(1);
  });

  it('отрицание само по себе не разрешает слово: «гарантируем, что не» проходило бы', () => {
    const found = banned(scanDictionaries(dict('trust.weDo.1', {
      ru: 'Мы гарантируем, что деньги не пропадут.',
    })));
    expect(found.map((finding) => finding.ruleId)).toContain('guarantee');
  });
});

describe('отгружённые словари', () => {
  const dicts = shipped();

  it('запрещённых слов нет ни в одном из трёх словарей', () => {
    const found = banned(scanDictionaries(dicts));
    expect(found.map(formatFinding)).toEqual([]);
  });

  it('ни одно исключение не пережило свой текст', () => {
    const result = scanDictionaries(dicts);
    expect(result.unusedAllowances.map((item) => `${item.rule}/${item.key}`)).toEqual([]);
  });

  it('исключений не больше, чем правил: список не подменяет собой проверку', () => {
    expect(ALLOWANCES.length).toBeLessThanOrEqual(LEXICON.length);
  });

  it('прогон не трогает словари', () => {
    const before = JSON.stringify(dicts);
    scanDictionaries(dicts);
    expect(JSON.stringify(dicts)).toEqual(before);
  });
});
