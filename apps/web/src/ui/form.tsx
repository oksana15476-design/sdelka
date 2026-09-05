import type { ReactNode } from 'react';
import { type MessageParams, t } from '@/i18n/translate';
import type { L10n } from './l10n';
import { StatusDot } from './primitives';

/**
 * Органы формы: поле, выбор, кнопка, сводка ошибок.
 *
 * ## Почему это появилось только сейчас
 *
 * До этого захода во всём приложении не было ни одного `<input>` и ни одного
 * `<button>`: интерфейс состоял из ссылок и текста. Экран вывода при этом
 * обещал «забрать можно в любой момент» и вёл на страницу, где заявку **нечем
 * создать** (`CABINETS-REDESIGN.md` §1.2, заход 1.6). Первая настоящая форма —
 * это же и первый контракт на орган управления, поэтому он записан здесь, а не
 * разложен по экранам.
 *
 * ## Контракт
 *
 * 1. **Форма работает без JavaScript.** `method="get"`, состояние — в адресе,
 *    проверка — на сервере. Экран денег, который перестаёт работать от
 *    неприехавшего скрипта, — это экран, который иногда не работает.
 * 2. **У каждого поля есть подпись, и она связана с полем** через `for`/`id`, а
 *    не поставлена рядом: заполнитель подписью не является.
 * 3. **Ошибка живёт у поля**, названа словами и связана с ним `aria-describedby`.
 *    Красная рамка без текста — это цвет как единственный носитель состояния.
 * 4. **Недоступное действие не рисуется отключённой кнопкой**: `disabled`
 *    скринридер пропускает, и причина остаётся непрочитанной (`BlockedAction`).
 * 5. **Фокус виден на самом элементе.** Кольцо на обёртке вместо поля — это
 *    кольцо, которого проверка не находит, а глаз не видит на контрастной теме.
 */

/** Поле формы: подпись, орган, подсказка и ошибка — одним блоком. */
export function FormField({
  l,
  name,
  labelKey,
  hintKey,
  hintParams,
  errorKey,
  errorParams,
  children,
}: {
  readonly l: L10n;
  readonly name: string;
  readonly labelKey: string;
  readonly hintKey?: string | undefined;
  readonly hintParams?: MessageParams | undefined;
  readonly errorKey?: string | null | undefined;
  readonly errorParams?: MessageParams | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="formfield">
      <label className="formfield__label" htmlFor={name}>
        {t(l.dict, labelKey)}
      </label>
      <div className="formfield__control">{children}</div>
      {hintKey === undefined ? null : (
        <span className="formfield__hint" id={`${name}-hint`}>
          {t(l.dict, hintKey, hintParams)}
        </span>
      )}
      {errorKey === undefined || errorKey === null ? null : (
        <span className="formfield__error" id={`${name}-error`}>
          <StatusDot tone="danger" />
          <span>{t(l.dict, errorKey, errorParams)}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Поле суммы.
 *
 * `type="text"` вместо `type="number"` — намеренно: числовое поле в разных
 * локалях по-разному относится к запятой, молча теряет ввод при прокрутке
 * колесом и не даёт показать человеку ровно то, что он напечатал. Разбор строки
 * всё равно наш (`view/withdraw-form.ts`), а клавиатуру на телефоне поднимает
 * `inputMode`.
 *
 * Код валюты стоит **рядом с полем, а не внутри**: внутри он либо перекрывается
 * длинным числом, либо требует отступа, подобранного под одну гарнитуру.
 */
export function AmountField({
  l,
  name,
  labelKey,
  unit,
  value,
  hintKey,
  hintParams,
  errorKey,
  errorParams,
}: {
  readonly l: L10n;
  readonly name: string;
  readonly labelKey: string;
  readonly unit: string;
  readonly value: string;
  readonly hintKey?: string | undefined;
  readonly hintParams?: MessageParams | undefined;
  readonly errorKey?: string | null | undefined;
  readonly errorParams?: MessageParams | undefined;
}): ReactNode {
  const invalid = errorKey !== undefined && errorKey !== null;
  const described = [hintKey === undefined ? null : `${name}-hint`, invalid ? `${name}-error` : null]
    .filter((item) => item !== null)
    .join(' ');
  return (
    <FormField
      errorKey={errorKey}
      errorParams={errorParams}
      hintKey={hintKey}
      hintParams={hintParams}
      l={l}
      labelKey={labelKey}
      name={name}
    >
      <input
        aria-describedby={described === '' ? undefined : described}
        aria-invalid={invalid ? 'true' : undefined}
        autoComplete="off"
        className={`fld fld--amount${invalid ? ' fld--invalid' : ''}`}
        defaultValue={value}
        id={name}
        inputMode="decimal"
        name={name}
        type="text"
      />
      <span className="formfield__unit">{unit}</span>
    </FormField>
  );
}

export interface Choice {
  readonly value: string;
  readonly label: ReactNode;
  readonly meta?: ReactNode | undefined;
}

/**
 * Закрытый выбор из нескольких — радиокнопками, а не выпадающим списком.
 *
 * Список прячет варианты за нажатием, и на экране денег это стоит дорого:
 * валюта, которой у клиента нет, и валюта, которой у него больше всего,
 * выглядят одинаково, пока список закрыт. Здесь варианты видны все сразу и
 * каждый несёт свой остаток.
 */
export function ChoiceField({
  l,
  name,
  labelKey,
  choices,
  value,
  errorKey,
}: {
  readonly l: L10n;
  readonly name: string;
  readonly labelKey: string;
  readonly choices: readonly Choice[];
  readonly value: string;
  readonly errorKey?: string | null | undefined;
}): ReactNode {
  return (
    <fieldset className="formfield formfield--group" id={name}>
      <legend className="formfield__label">{t(l.dict, labelKey)}</legend>
      <div className="choices">
        {choices.map((choice) => (
          <label className="choice" key={choice.value}>
            <input
              className="choice__input"
              defaultChecked={choice.value === value}
              name={name}
              type="radio"
              value={choice.value}
            />
            <span className="choice__body">
              <span className="choice__label">{choice.label}</span>
              {choice.meta === undefined ? null : <span className="choice__meta">{choice.meta}</span>}
            </span>
          </label>
        ))}
      </div>
      {errorKey === undefined || errorKey === null ? null : (
        <span className="formfield__error">
          <StatusDot tone="danger" />
          <span>{t(l.dict, errorKey)}</span>
        </span>
      )}
    </fieldset>
  );
}

/**
 * Кнопка отправки. Имя и значение несут **шаг**, а не намерение вообще: форма
 * работает без скрипта, и нажатая кнопка — единственное, что отличает
 * «посчитать всё свободное» от «перейти к сверке».
 */
export function SubmitButton({
  l,
  labelKey,
  name,
  value,
  tone = 'primary',
}: {
  readonly l: L10n;
  readonly labelKey: string;
  readonly name: string;
  readonly value: string;
  readonly tone?: 'primary' | 'secondary' | undefined;
}): ReactNode {
  return (
    <button
      className={`btn${tone === 'secondary' ? ' btn--secondary' : ''}`}
      name={name}
      type="submit"
      value={value}
    >
      {t(l.dict, labelKey)}
    </button>
  );
}

export interface FormProblem {
  readonly field: string;
  readonly messageKey: string;
  readonly params?: MessageParams | undefined;
}

/**
 * Сводка ошибок над формой.
 *
 * Нужна не вместо подписей у полей, а вместе с ними: человек, увидевший
 * страницу заново после отправки, обязан узнать об отказе **до** того, как
 * дойдёт до поля, — особенно на телефоне, где поле уехало за край экрана.
 * Поэтому здесь `role="alert"` и ссылки на сами поля, а полный текст стоит
 * внизу, у органа.
 */
export function ErrorSummary({
  l,
  titleKey,
  problems,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly problems: readonly FormProblem[];
}): ReactNode {
  if (problems.length === 0) return null;
  return (
    <div className="errors" role="alert">
      <p className="errors__title">{t(l.dict, titleKey)}</p>
      <ul className="errors__list">
        {problems.map((problem) => (
          <li key={`${problem.field}:${problem.messageKey}`}>
            <a href={`#${problem.field}`}>{t(l.dict, problem.messageKey, problem.params)}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
