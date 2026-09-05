/**
 * Машинная проверка доступности по WCAG 2.1 AA — расширение обхода
 * `verify-ui.mjs`, а не второй обход.
 *
 * ## Зачем отдельным модулем
 *
 * Правил семь, и каждое из них — вычисление, а не поиск подстроки: контраст
 * считается из **вычисленных** стилей с учётом прозрачности и подложки, имя
 * элемента собирается по тем же шагам, что у скринридера, видимость фокуса
 * меряется разностью стилей до и после. Это полторы сотни строк логики, которым
 * не место посреди маршрутного обхода: там они перестанут читаться и первым же
 * заходом разъедутся с правилами.
 *
 * Функция `wcagAudit` уезжает в браузер целиком (Playwright сериализует её
 * исходник), поэтому она **не имеет права ссылаться на внешнюю область
 * видимости**: всё, что ей нужно, приходит одним аргументом. Ровно по этой
 * причине здесь нет ни `import`, ни общих констант с обходом.
 *
 * ## Что проверяется и чего проверка не умеет
 *
 * | Правило | Успех | Чего не видит |
 * |---|---|---|
 * | 1.4.3 контраст текста | 4.5:1, крупный 3:1 | текст поверх картинки и градиента — помечается «не измерено» |
 * | 1.4.11 контраст границ | 3:1 у поля и у органа с рамкой | состояния наведения и нажатия |
 * | 4.1.2 имя элемента | поле, кнопка, ссылка | качество имени, только наличие |
 * | 1.1.1 картинки | `alt` либо явная декоративность | осмысленность `alt` |
 * | 1.3.1 порядок заголовков | без разрыва уровней | логику вложенности |
 * | 2.4.7 видимый фокус | кольцо есть и отличимо от фона (3:1) | фокус при наведении мышью |
 * | 3.1.1 язык страницы | `lang` совпадает с локалью маршрута | язык отдельных фрагментов |
 * | 1.4.1 не только цветом | тон + текст либо фигура | смысл, вложенный в оттенок данных |
 * | 2.5.8 цель нажатия | 24×24 с исключениями по расстоянию и строке | «существенные» цели |
 *
 * Строка о том, чего проверка не видит, стоит здесь не из скромности: проверка,
 * о границах которой не сказано, читается как гарантия, и через месяц её
 * зелёный результат приводят как доказательство доступности целиком.
 */

/**
 * Пороги. Вынесены наружу, потому что о них спорят, и спор должен упираться в
 * одно место, а не в семь мест внутри браузерного кода.
 */
export const WCAG = Object.freeze({
  /** 1.4.3, обычный текст. */
  textContrast: 4.5,
  /** 1.4.3, крупный текст: от 24px, либо от 18.66px при начертании 700. */
  largeTextContrast: 3,
  largeSizePx: 24,
  largeBoldSizePx: 18.66,
  /** 1.4.11 — границы органов управления и графика, несущая смысл. */
  nonTextContrast: 3,
  /** 2.5.8 — минимальная цель нажатия. */
  targetSizePx: 24,
});

/**
 * Аудит одной страницы. Возвращает `{ problems, notices }`: `problems` роняют
 * прогон, `notices` печатаются и не роняют — там живёт то, что проверка честно
 * **не смогла** измерить (текст поверх картинки, невоспроизводимый фокус).
 *
 * @param {{ locale: string, thresholds: typeof WCAG }} options
 */
export function wcagAudit(options) {
  const T = options.thresholds;
  const notices = [];

  /**
   * Одно нарушение — одна строка, даже если элементов двадцать восемь.
   *
   * Список сделок держит двадцать восемь одинаковых кнопок, и каждая из них
   * нарушает то же правило по той же причине. Двадцать восемь строк в отчёте —
   * это не двадцать восемь работ, это одна работа и потерянный отчёт: рядом
   * стоящее единственное нарушение другого правила в такой выдаче не видно.
   * Поэтому findings схлопываются по паре «правило + мера», а число вхождений
   * печатается рядом — оно говорит о распространённости, и терять его тоже
   * нельзя.
   */
  const findings = new Map();
  const add = (rule, where, detail) => {
    const signature = `${rule}|${where.replace(/\s«[^»]*»/u, '')}|${detail}`;
    const seen = findings.get(signature);
    if (seen === undefined) findings.set(signature, { rule, where, detail, count: 1 });
    else seen.count += 1;
  };

  /* ------------------------------------------------------------- цвет */

  const parseColor = (value) => {
    if (typeof value !== 'string') return null;
    if (value === 'transparent') return [0, 0, 0, 0];
    const parts = value.match(/-?[\d.]+(?:e-?\d+)?/gu);
    if (parts === null || parts.length < 3) return null;
    const nums = parts.map(Number);
    return [nums[0], nums[1], nums[2], parts.length > 3 ? nums[3] : 1];
  };

  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  const contrast = (a, b) => {
    const first = luminance(a);
    const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };

  /** Полупрозрачный слой поверх непрозрачного: WCAG считает по тому, что видно. */
  const over = (rgba, base) => {
    const alpha = rgba[3];
    if (alpha >= 1) return [rgba[0], rgba[1], rgba[2]];
    return [0, 1, 2].map((i) => rgba[i] * alpha + base[i] * (1 - alpha));
  };

  /**
   * Подложка под узлом. Слои складываются сверху вниз с учётом прозрачности —
   * ровно так их видит глаз. Картинка или градиент делают цвет неизвестным:
   * такой узел уходит в `notices`, а не в тихий пропуск и не в ложное падение.
   */
  const backgroundOf = (node) => {
    const layers = [];
    let current = node;
    while (current !== null && current instanceof Element) {
      const style = getComputedStyle(current);
      if (style.backgroundImage !== 'none') return { rgb: null, reason: 'фон картинкой или градиентом' };
      const color = parseColor(style.backgroundColor);
      if (color !== null && color[3] > 0) {
        layers.push(color);
        if (color[3] >= 1) break;
      }
      current = current.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    return { rgb: base, reason: null };
  };

  /** Прозрачность копится по предкам: `opacity: .5` внутри `opacity: .5` — это .25. */
  const opacityOf = (node) => {
    let value = 1;
    let current = node;
    while (current !== null && current instanceof Element) {
      value *= Number(getComputedStyle(current).opacity);
      current = current.parentElement;
    }
    return value;
  };

  /* ------------------------------------------------------- видимость и имя */

  const rendered = (node) => {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = node.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };

  /** Текст «для скринридера»: на экране его нет, мерить у него нечего. */
  const offscreen = (node) => {
    let current = node;
    while (current !== null && current instanceof Element) {
      if (current.classList.contains('visually-hidden')) return true;
      const style = getComputedStyle(current);
      if (style.clipPath === 'inset(50%)') return true;
      current = current.parentElement;
    }
    return false;
  };

  const hiddenFromReader = (node) => node.closest('[aria-hidden="true"]') !== null;

  const describe = (node) => {
    const cls = String(node.getAttribute('class') || '')
      .split(/\s+/u)
      .filter((item) => item !== '')
      .slice(0, 2)
      .join('.');
    const tag = node.tagName.toLowerCase() + (cls === '' ? '' : `.${cls}`);
    const text = (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/gu, ' ').trim();
    return text === '' ? tag : `${tag} «${text.slice(0, 40)}»`;
  };

  /**
   * Доступное имя — по шагам вычисления имени, а не «есть ли атрибут»:
   * `aria-labelledby` → `aria-label` → подпись `<label>` → содержимое →
   * `title` → `value`/`alt` → заполнитель. Заполнитель стоит последним и
   * намеренно: подписью он не является, но имя даёт, и падать на нём значило бы
   * ловить не то правило.
   */
  const accessibleName = (node) => {
    const labelledby = node.getAttribute('aria-labelledby');
    if (labelledby !== null) {
      const text = labelledby
        .split(/\s+/u)
        .map((id) => document.getElementById(id))
        .filter((item) => item !== null)
        .map((item) => item.textContent || '')
        .join(' ')
        .trim();
      if (text !== '') return text;
    }
    const label = node.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') return label.trim();
    const labels = node.labels;
    if (labels !== undefined && labels !== null && labels.length > 0) {
      const text = [...labels].map((item) => item.textContent || '').join(' ').trim();
      if (text !== '') return text;
    }
    if (node.tagName === 'FIELDSET') {
      const legend = node.querySelector('legend');
      if (legend !== null && (legend.textContent || '').trim() !== '') return legend.textContent.trim();
    }
    const own = (node.textContent || '').trim();
    if (own !== '') return own;
    const title = node.getAttribute('title');
    if (title !== null && title.trim() !== '') return title.trim();
    for (const attribute of ['value', 'alt', 'placeholder']) {
      const value = node.getAttribute(attribute);
      if (value !== null && value.trim() !== '') return value.trim();
    }
    return '';
  };

  /* ----------------------------------------- 1.4.3 контраст текста и подсказки */

  const TEXT_HOSTS = 'body *';
  for (const node of document.querySelectorAll(TEXT_HOSTS)) {
    const direct = [...node.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent || '')
      .join('')
      .trim();
    if (direct === '') continue;
    if (!rendered(node) || offscreen(node)) continue;
    const style = getComputedStyle(node);
    const alpha = opacityOf(node);
    if (alpha < 0.05) continue;
    const background = backgroundOf(node);
    if (background.rgb === null) {
      notices.push(`[1.4.3] ${describe(node)}: контраст не измерен — ${background.reason}`);
      continue;
    }
    const raw = parseColor(style.color);
    if (raw === null) continue;
    const fg = over([raw[0], raw[1], raw[2], raw[3] * alpha], background.rgb);
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= T.largeSizePx || (size >= T.largeBoldSizePx && weight >= 700);
    const required = large ? T.largeTextContrast : T.textContrast;
    const ratio = contrast(fg, background.rgb);
    if (ratio < required - 0.005) {
      add(
        '1.4.3 контраст текста',
        describe(node),
        `${ratio.toFixed(2)}:1 при требуемых ${required}:1 (${Math.round(size)}px/${weight})`,
      );
    }
  }

  for (const node of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (!rendered(node)) continue;
    const background = backgroundOf(node);
    if (background.rgb === null) continue;
    const style = getComputedStyle(node, '::placeholder');
    const raw = parseColor(style.color);
    if (raw === null) continue;
    const fg = over(raw, background.rgb);
    const ratio = contrast(fg, background.rgb);
    if (ratio < T.textContrast - 0.005) {
      add(
        '1.4.3 контраст текста',
        `${describe(node)} ::placeholder`,
        `${ratio.toFixed(2)}:1 при требуемых ${T.textContrast}:1`,
      );
    }
  }

  /* ------------------------------------- 1.4.11 контраст границ органов управления */

  /**
   * Граница поля — не украшение: без неё поле неотличимо от подложки, и
   * «куда печатать» узнаётся только по подписи рядом. Поэтому у поля граница
   * требуется всегда, а у прочих органов — только если она задумана (есть
   * рамка либо своя заливка): текстовая кнопка опознаётся текстом, и требовать
   * от неё рамку значило бы проверять вкус, а не правило.
   */
  const boundaryOf = (node) => {
    const outside = backgroundOf(node.parentElement);
    if (outside.rgb === null) return null;
    const style = getComputedStyle(node);
    const ownRaw = parseColor(style.backgroundColor) ?? [0, 0, 0, 0];
    const own = over(ownRaw, outside.rgb);
    let best = ownRaw[3] > 0 ? contrast(own, outside.rgb) : 1;
    let bordered = false;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const width = parseFloat(style[`border${side}Width`]);
      const kind = style[`border${side}Style`];
      if (!(width > 0) || kind === 'none' || kind === 'hidden') continue;
      const raw = parseColor(style[`border${side}Color`]);
      if (raw === null || raw[3] === 0) continue;
      bordered = true;
      best = Math.max(best, contrast(over(raw, own), own), contrast(over(raw, outside.rgb), outside.rgb));
    }
    return { ratio: best, bordered, filled: ownRaw[3] > 0.05 };
  };

  const FIELDS = 'input:not([type="hidden"]), select, textarea';
  const CONTROLS = `${FIELDS}, button, [role="button"], .btn, .chipbtn, .choice`;
  /**
   * Орган, который рисует **браузер**, а не мы: флажок и радиокнопка с
   * `appearance: auto`. Контур у них не задан ни одним свойством CSS — он
   * приходит из платформы (в Chromium это #767676, то есть 4.5:1 к белому), и
   * измерить его через `getComputedStyle` нельзя ни при какой попытке.
   *
   * Требовать 3:1 от того, чего в стилях нет, значило бы получать 1.00:1 на
   * каждой радиокнопке приложения — семнадцать «нарушений» на экране вывода,
   * ни одно из которых не почини́ть иначе, чем отказом от родного органа.
   * Поэтому такие узлы исключены, а рамка **карточки выбора** (`.choice`),
   * которая наша, проверяется наравне с прочими.
   */
  const nativeWidget = (node) =>
    (node.type === 'radio' || node.type === 'checkbox' || node.type === 'range' || node.type === 'color') &&
    getComputedStyle(node).appearance === 'auto';
  for (const node of document.querySelectorAll(CONTROLS)) {
    if (!rendered(node) || nativeWidget(node)) continue;
    const boundary = boundaryOf(node);
    if (boundary === null) continue;
    const isField = node.matches(FIELDS);
    if (!isField && !boundary.bordered && !boundary.filled) continue;
    if (boundary.ratio < T.nonTextContrast - 0.005) {
      add(
        '1.4.11 контраст границы',
        describe(node),
        `${boundary.ratio.toFixed(2)}:1 при требуемых ${T.nonTextContrast}:1 — граница неотличима от подложки`,
      );
    }
  }

  /* ---------------------------------- 4.1.2 и 1.1.1: имя элемента, альтернатива */

  for (const node of document.querySelectorAll(FIELDS)) {
    if (!rendered(node) && !offscreen(node)) continue;
    if (node.type === 'submit' || node.type === 'button' || node.type === 'reset') continue;
    if (accessibleName(node) === '') {
      add('4.1.2 имя поля', describe(node), 'доступного имени нет — ни подписи, ни aria-label');
    }
  }

  for (const node of document.querySelectorAll('button, [role="button"], summary, a[href], input[type="submit"]')) {
    if (!rendered(node)) continue;
    if (hiddenFromReader(node)) continue;
    if (accessibleName(node) === '') {
      add('4.1.2 имя органа', describe(node), 'доступного имени нет — на экране орган без надписи');
    }
  }

  for (const node of document.querySelectorAll('img')) {
    const decorative =
      node.getAttribute('role') === 'presentation' ||
      node.getAttribute('role') === 'none' ||
      node.getAttribute('aria-hidden') === 'true';
    if (decorative) continue;
    if (!node.hasAttribute('alt')) {
      add('1.1.1 альтернатива', describe(node), 'нет ни alt, ни явной декоративности');
    }
  }

  for (const node of document.querySelectorAll('svg')) {
    if (node.getAttribute('aria-hidden') === 'true' || node.closest('[aria-hidden="true"]') !== null) continue;
    if (node.getAttribute('role') === 'img' && accessibleName(node) !== '') continue;
    add('1.1.1 альтернатива', describe(node), 'рисунок без имени и без пометки декоративности');
  }

  /* -------------------------------------------- 1.3.1 порядок заголовков */

  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].filter(
    (node) => rendered(node) || offscreen(node),
  );
  let previous = 0;
  for (const node of headings) {
    const level =
      node.getAttribute('role') === 'heading'
        ? Number(node.getAttribute('aria-level') || 2)
        : Number(node.tagName.slice(1));
    if (previous === 0) {
      if (level !== 1) {
        add('1.3.1 порядок заголовков', describe(node), `первый заголовок уровня ${level}, а не h1`);
      }
    } else if (level > previous + 1) {
      add(
        '1.3.1 порядок заголовков',
        describe(node),
        `h${level} сразу после h${previous} — уровень h${previous + 1} пропущен`,
      );
    }
    previous = level;
  }

  /* ------------------------------------------------ 2.4.7 видимость фокуса */

  /**
   * Кольцо меряется разностью: стиль снимается у элемента в фокусе и у него же
   * без фокуса, вместе с псевдоэлементами. Проверка «есть ли `outline`» так не
   * умеет — постоянная рамка прошла бы за кольцо, а кольцо на `::after` не
   * прошло бы вовсе.
   *
   * Мало того, что кольцо **есть**: оно обязано быть отличимо от того, на чём
   * нарисовано, — 3:1 к подложке. Синее кольцо на синей кнопке видно ровно
   * так же, как его отсутствие.
   *
   * `:focus-visible` при программной установке фокуса включается только если
   * последним человек работал клавиатурой. Обход к этому месту уже нажимал Tab;
   * если состояние всё-таки не воспроизвелось, это уходит в `notices` —
   * непроверенное не выдаётся ни за нарушение, ни за успех.
   */
  const FOCUSABLE = 'a[href], button, summary, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const readStyle = (node) => {
    const out = [];
    for (const pseudo of [null, '::before', '::after']) {
      const style = getComputedStyle(node, pseudo);
      out.push(
        [
          style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset,
          style.boxShadow, style.backgroundColor, style.color, style.borderColor,
          style.textDecorationLine, style.content, style.opacity, style.transform,
        ].join('~'),
      );
    }
    return out.join('|');
  };
  const active = document.activeElement;
  let reproduced = 0;
  let attempted = 0;
  for (const node of document.querySelectorAll(FOCUSABLE)) {
    if (!rendered(node)) continue;
    attempted += 1;
    node.focus({ preventScroll: true });
    if (document.activeElement !== node) continue;
    const isVisible = node.matches(':focus-visible');
    const focused = readStyle(node);
    const style = getComputedStyle(node);
    const outlineWidth = parseFloat(style.outlineWidth);
    const outlineColor = parseColor(style.outlineColor);
    const outlineDrawn = style.outlineStyle !== 'none' && outlineWidth > 0 && outlineColor !== null && outlineColor[3] > 0;
    node.blur();
    const blurred = readStyle(node);
    if (!isVisible) continue;
    reproduced += 1;
    if (focused === blurred) {
      add('2.4.7 видимый фокус', describe(node), 'стиль элемента не меняется от фокуса — кольца нет');
      continue;
    }
    if (!outlineDrawn) continue;
    const outside = backgroundOf(node.parentElement);
    if (outside.rgb === null) continue;
    const ring = over(outlineColor, outside.rgb);
    const ratio = contrast(ring, outside.rgb);
    if (ratio < T.nonTextContrast - 0.005) {
      add(
        '2.4.7 видимый фокус',
        describe(node),
        `кольцо ${ratio.toFixed(2)}:1 к подложке при требуемых ${T.nonTextContrast}:1`,
      );
    }
  }
  if (attempted > 0 && reproduced === 0) {
    notices.push('[2.4.7] состояние :focus-visible не воспроизвелось — видимость фокуса не измерена');
  }
  if (active instanceof HTMLElement) active.focus({ preventScroll: true });

  /* ---------------------------------------------------- 3.1.1 язык страницы */

  const lang = document.documentElement.getAttribute('lang');
  if (lang === null || lang.trim() === '') {
    add('3.1.1 язык страницы', 'html', 'атрибут lang не объявлен');
  } else if (lang.split('-')[0].toLowerCase() !== options.locale) {
    add('3.1.1 язык страницы', 'html', `lang="${lang}" при локали маршрута «${options.locale}»`);
  }
  if (document.documentElement.getAttribute('dir') === null) {
    add('3.1.1 язык страницы', 'html', 'направление письма dir не объявлено');
  }

  /* ------------------------------------------- 1.4.1 не только цветом */

  /**
   * Тон — это цвет. Смысл, вложенный в тон, обязан быть продублирован словом
   * либо фигурой, иначе состояние транша, ошибка поля и предупреждение
   * существуют только для того, кто различает оттенки.
   */
  const TONE = /--(ok|warn|danger|info|wait|refund|action|critical|urgent|paused|invalid|loss|positive|negative)\b/u;
  for (const node of document.querySelectorAll('[class*="--"]')) {
    const classes = String(node.getAttribute('class') || '');
    if (!TONE.test(classes)) continue;
    if (!rendered(node) || hiddenFromReader(node)) continue;
    const text = (node.textContent || '').trim();
    if (text !== '') continue;
    if ((node.getAttribute('aria-label') || '').trim() !== '') continue;
    if (node.querySelector('svg, img, .dot') !== null) continue;
    if (node.matches(FIELDS)) continue;
    add(
      '1.4.1 не только цветом',
      describe(node),
      `тон «${(classes.match(TONE) ?? [''])[0]}» без слова и без фигуры`,
    );
  }

  /**
   * Индикатор без слова рядом.
   *
   * Точка декоративна (`aria-hidden`) и несёт фигуру; смысл обязан стоять
   * словом в том же блоке. Ищем ближайшего предка с текстом, поднимаясь не
   * выше трёх уровней: выше — уже не «рядом», а «где-то на странице», и
   * проверка перестала бы отличать подпись у индикатора от подписи у карточки.
   * Три уровня — это ровно то, что нужно ленте состояний
   * (`.dot` → `.timeline__mark` → `.timeline__step`, где подпись шага и
   * скрытое название состояния), и мало для точки в пустой ячейке таблицы.
   *
   * Найденный текст обязан относиться к **одному** индикатору: блок с двумя
   * точками и одной подписью не называет ни одну из них.
   */
  for (const node of document.querySelectorAll('.dot')) {
    if (!rendered(node)) continue;
    let host = node.parentElement;
    let named = false;
    for (let level = 0; level < 3 && host !== null; level += 1) {
      const text = (host.textContent || '').replace(/\s+/gu, ' ').trim();
      const labelled = `${host.getAttribute('aria-label') ?? ''}${host.getAttribute('title') ?? ''}`.trim();
      if (text !== '' || labelled !== '') {
        if (host.querySelectorAll('.dot').length > 1 && labelled === '') {
          add('1.4.1 не только цветом', describe(host), 'одна подпись на несколько индикаторов состояния');
        }
        named = true;
        break;
      }
      host = host.parentElement;
    }
    if (!named) {
      add('1.4.1 не только цветом', describe(node.parentElement ?? node), 'индикатор состояния без текста рядом');
    }
  }

  /** Поле с отказом: рамка цветом — не сообщение. Нужны и признак, и слова. */
  for (const node of document.querySelectorAll('.fld--invalid, [aria-invalid="true"]')) {
    if (!rendered(node)) continue;
    if (node.getAttribute('aria-invalid') !== 'true') {
      add('1.4.1 не только цветом', describe(node), 'красная рамка без aria-invalid');
      continue;
    }
    const described = (node.getAttribute('aria-describedby') || '')
      .split(/\s+/u)
      .map((id) => document.getElementById(id))
      .filter((item) => item !== null)
      .map((item) => (item.textContent || '').trim())
      .filter((item) => item !== '');
    if (described.length === 0) {
      add('1.4.1 не только цветом', describe(node), 'отказ ввода не назван словами — нет aria-describedby с текстом');
    }
  }

  /**
   * Две фигуры индикатора совпали — значит два состояния различаются одним
   * оттенком. Это не падение: рядом с точкой стоит слово, и оно проверено выше.
   * Но фигура заявлена дизайн-системой как второй носитель смысла, и молчать о
   * том, что второго носителя у пары состояний нет, нельзя.
   */
  const shapes = new Map();
  for (const node of document.querySelectorAll('.dot')) {
    if (!rendered(node)) continue;
    const tone = (String(node.getAttribute('class') || '').match(/dot--(\w+)/u) ?? [null, '?'])[1];
    const style = getComputedStyle(node);
    /* Заливка и контур — разные фигуры, и в отпечаток входят обе: круг
       закрашенный и круг-контур дают одинаковые `clip-path` и `border-radius`,
       а на экране это ● и ○. Поворот тоже: ромб от квадрата отличается им. */
    const filled = (parseColor(style.backgroundColor) ?? [0, 0, 0, 0])[3] > 0 ? 'fill' : 'hollow';
    const signature = `${style.clipPath}|${style.borderRadius}|${style.borderTopWidth}|${style.transform}|${filled}`;
    if (!shapes.has(signature)) shapes.set(signature, new Set());
    shapes.get(signature).add(tone);
  }
  for (const tones of shapes.values()) {
    if (tones.size > 1) {
      notices.push(`[1.4.1] одна фигура индикатора у состояний: ${[...tones].join(', ')} — различает только цвет`);
    }
  }

  /* -------------------------------------------------- 2.5.8 цель нажатия */

  const targets = [...document.querySelectorAll(`${FOCUSABLE}, [role="button"], label.choice`)]
    .filter((node) => rendered(node))
    .map((node) => ({ node, box: node.getBoundingClientRect() }));
  const centres = targets.map((item) => ({
    x: item.box.left + item.box.width / 2,
    y: item.box.top + item.box.height / 2,
  }));
  targets.forEach((item, index) => {
    if (item.box.width >= T.targetSizePx && item.box.height >= T.targetSizePx) return;
    // Исключение «в строке текста»: ссылка внутри предложения, увеличение
    // которой рвёт строку. Признак — вокруг заметно больше текста, чем в ней.
    const own = (item.node.textContent || '').trim().length;
    const around = (item.node.parentElement?.textContent || '').trim().length;
    const inline = getComputedStyle(item.node).display === 'inline' && around > own * 1.3;
    if (inline) return;
    // Исключение «по расстоянию»: круг 24 px вокруг цели не задевает круг
    // соседней цели — тогда промахнуться некуда.
    const spaced = centres.every((centre, other) => {
      if (other === index) return true;
      const dx = centre.x - centres[index].x;
      const dy = centre.y - centres[index].y;
      return Math.hypot(dx, dy) >= T.targetSizePx;
    });
    if (spaced) return;
    add(
      '2.5.8 цель нажатия',
      describe(item.node),
      `${Math.round(item.box.width)}×${Math.round(item.box.height)} при минимуме ${T.targetSizePx}×${T.targetSizePx} и соседе ближе ${T.targetSizePx} px`,
    );
  });

  const problems = [...findings.values()].map(
    (item) => `[${item.rule}] ${item.where}: ${item.detail}${item.count > 1 ? ` · таких элементов ${item.count}` : ''}`,
  );
  return { problems, notices };
}
