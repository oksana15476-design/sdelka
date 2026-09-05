/**
 * Самопроверка правил доступности: каждое правило обязано **сработать** на
 * заведомо сломанной странице и **промолчать** на заведомо целой.
 *
 * ## Зачем это существует
 *
 * Правило, которое ничего не находит, выглядит точно так же, как правило,
 * которое сломалось. Из девяти проверок в `wcag.mjs` семь на живом приложении
 * молчат — и это хорошая новость ровно до того дня, когда селектор разъедется с
 * разметкой, вычисление упадёт в `null` или условие перевернётся. С этого дня
 * они будут молчать по другой причине, и отличить одно от другого по отчёту
 * станет нельзя.
 *
 * Поэтому обход начинается с двух синтетических страниц. На первой сломано по
 * одному месту на правило; не сработавшее правило роняет прогон **до** того,
 * как обойдено хоть что-то. На второй те же самые места сделаны правильно;
 * сработавшее правило означает ложное срабатывание, и оно роняет прогон тоже —
 * проверка, которая находит нарушения на исправной странице, дороже отсутствия
 * проверки.
 *
 * Обе страницы держатся здесь, а не в `public`: они не часть продукта и не
 * должны отдаваться по адресу.
 */

import { WCAG, wcagAudit } from './wcag.mjs';

/**
 * Сломанная страница: по одному нарушению на правило, каждое подписано.
 *
 * Локаль проверки — `ru`, а объявлен `de` без `dir`: это и есть нарушение
 * 3.1.1. Порог 4.5:1 ломает `#a8a8a8` на белом (2.6:1), порог 3:1 у границы —
 * рамка `#f2f2f2` (1.1:1), кольцо фокуса снято глобальным `outline: none`.
 */
const BROKEN = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><style>
  body { background: #fff; color: #111; font: 16px/1.5 sans-serif; margin: 0; padding: 16px }
  .low { color: #a8a8a8 }
  .ctrl { border: 1px solid #f2f2f2; background: #fff; padding: 8px; font: inherit }
  .tiny { inline-size: 16px; block-size: 16px; padding: 0; border: 0; background: #2d5bff }
  .row { display: flex; gap: 2px }
  :focus-visible { outline: none }
  .dot { inline-size: 12px; block-size: 12px; background: #e5484d; display: inline-block }
</style></head>
<body>
  <h1>Заголовок страницы</h1>
  <h3>Уровень h2 пропущен</h3>
  <p class="low">Текст ниже порога контраста</p>
  <input class="ctrl" type="text">
  <button type="button"></button>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
  <svg height="10" width="10"><rect height="10" width="10"></rect></svg>
  <span class="badge--danger"></span>
  <span><span class="dot dot--danger"></span></span>
  <p class="row">
    <button aria-label="Первая" class="tiny" type="button"></button>
    <button aria-label="Вторая" class="tiny" type="button"></button>
  </p>
</body></html>`;

/**
 * Целая страница: те же самые места, сделанные правильно. Значения взяты из
 * токенов продукта — акцент `#2d5bff` (5.18:1 к белому) и граница органа
 * `#7c889c` (3.58:1), — чтобы ложное срабатывание ловилось на тех числах, с
 * которыми живёт приложение, а не на заведомо запасливых.
 */
const CLEAN = `<!doctype html>
<html dir="ltr" lang="ru">
<head><meta charset="utf-8"><style>
  body { background: #fff; color: #0f1729; font: 16px/1.5 sans-serif; margin: 0; padding: 16px }
  .ctrl { border: 1px solid #7c889c; background: #fff; padding: 8px; font: inherit }
  .big { min-inline-size: 44px; min-block-size: 44px; border: 1px solid #7c889c; background: #fff }
  .row { display: flex; gap: 8px }
  :focus-visible { outline: 3px solid #2d5bff; outline-offset: 2px }
  .dot { inline-size: 12px; block-size: 12px; background: #12a150; display: inline-block }
</style></head>
<body>
  <h1>Заголовок страницы</h1>
  <h2>Уровень на месте</h2>
  <p>Текст с достаточным контрастом</p>
  <label for="sum">Сумма</label>
  <input class="ctrl" id="sum" type="text">
  <button class="big" type="button">Отправить</button>
  <img alt="Схема расчёта" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
  <svg aria-hidden="true" height="10" width="10"><rect height="10" width="10"></rect></svg>
  <p class="badge--danger"><span class="dot"></span> Отказано</p>
  <p class="row">
    <button aria-label="Первая" class="big" type="button"></button>
    <button aria-label="Вторая" class="big" type="button"></button>
  </p>
</body></html>`;

/** Правила, которые обязаны сработать на сломанной странице. */
const EXPECTED = Object.freeze([
  '1.4.3 контраст текста',
  '1.4.11 контраст границы',
  '4.1.2 имя поля',
  '4.1.2 имя органа',
  '1.1.1 альтернатива',
  '1.3.1 порядок заголовков',
  '2.4.7 видимый фокус',
  '3.1.1 язык страницы',
  '1.4.1 не только цветом',
  '2.5.8 цель нажатия',
]);

async function auditOf(browser, html) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: 'ru' });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  /* Tab нажимается по-настоящему: `:focus-visible` при программной установке
     фокуса включается только тогда, когда последним человек работал
     клавиатурой. Без этого правило 2.4.7 не измеряется вовсе. */
  await page.keyboard.press('Tab');
  const audit = await page.evaluate(wcagAudit, { locale: 'ru', thresholds: WCAG });
  await context.close();
  return audit;
}

/**
 * @param {import('playwright').Browser} browser
 * @returns {Promise<string[]>} список расхождений; пустой — правила живы
 */
export async function selfTestWcag(browser) {
  const problems = [];

  const broken = await auditOf(browser, BROKEN);
  const fired = new Set(
    broken.problems.map((line) => (line.match(/^\[([^\]]+)\]/u) ?? [null, ''])[1]),
  );
  for (const rule of EXPECTED) {
    if (!fired.has(rule)) {
      problems.push(`правило «${rule}» не сработало на заведомо сломанной странице — проверки нет`);
    }
  }

  const clean = await auditOf(browser, CLEAN);
  for (const line of clean.problems) {
    problems.push(`ложное срабатывание на заведомо целой странице — ${line}`);
  }

  return { problems, fired: fired.size, expected: EXPECTED.length };
}
