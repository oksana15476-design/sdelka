import type { ReactNode } from 'react';
import { t } from '@/i18n/translate';
import { Disclosure, Eyebrow, StatusDot, legalSlotPending } from './primitives';
import { FormField } from './form';
import type { L10n } from './l10n';

/**
 * Блоки публичных страниц (`docs/product/LANDING.md` §6).
 *
 * ## Что здесь есть и чего нет
 *
 * Здесь только раскладка. Ни одной строки текста: всё приходит ключами, а
 * значения лежат в трёх словарях **черновиком** и перечислены в
 * `PENDING_COPY_KEYS` — связка копирайтер → главред их ещё не смотрела
 * (`CLAUDE.md`, «Разделение работы»). Дизайн-агент оставляет место правильной
 * длины, а не сочиняет текст.
 *
 * Строки с юридическим весом — статус сервиса, три правила Ю-25, ответы «а вы
 * кто такие» и «что если вы закроетесь», цена и текст согласия — заведены
 * ⚖-слотами (`PENDING_LEGAL_SLOTS`) и **не рендерятся вовсе**, пока их не
 * напишет юрист. Черновик на месте такого утверждения читается как обещание,
 * а внутренняя пометка на месте обещания — это наш процесс, вынесенный клиенту.
 */

/** Надзаголовок и заголовок страницы: единственный `h1` на экране. */
export function PublicHead({
  l,
  eyebrowKey,
  titleKey,
  leadKey,
  children,
}: {
  readonly l: L10n;
  readonly eyebrowKey: string;
  readonly titleKey: string;
  readonly leadKey: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <header className="hero">
      <Eyebrow l={l} labelKey={eyebrowKey} />
      <h1 className="hero__title">{t(l.dict, titleKey)}</h1>
      <p className="hero__lead">{t(l.dict, leadKey)}</p>
      {children}
    </header>
  );
}

/**
 * Секция страницы: заголовок второго уровня и содержимое.
 *
 * Карточка здесь — группировка по смыслу, а не украшение: каждый блок отвечает
 * на один вопрос читателя целиком. Вложенных карточек нет ни одной.
 */
export function PublicSection({
  l,
  id,
  titleKey,
  noteKey,
  children,
}: {
  readonly l: L10n;
  readonly id: string;
  readonly titleKey: string;
  readonly noteKey?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section aria-labelledby={id} className="card">
      <h2 className="card__title" id={id}>
        {t(l.dict, titleKey)}
      </h2>
      {noteKey === undefined ? null : <p className="muted">{t(l.dict, noteKey)}</p>}
      <div className="stack" style={{ marginBlockStart: 'var(--s-4)' }}>
        {children}
      </div>
    </section>
  );
}

/** Факт: короткий заголовок третьего уровня и одно проверяемое утверждение. */
export function FactCard({
  l,
  titleKey,
  bodyKey,
  params,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly params?: Readonly<Record<string, string>>;
}): ReactNode {
  return (
    <div className="fact">
      <h3 className="fact__title">{t(l.dict, titleKey)}</h3>
      <p className="fact__body">{t(l.dict, bodyKey, params)}</p>
    </div>
  );
}

/**
 * Ответ на вопрос «кто решает, что деньги пора отдавать» (`LANDING.md` §4).
 *
 * Три ответа стоят одинаковыми карточками, и наш выделен рамкой, а не
 * умолчанием: карточка, показывающая только хороший исход, читается как
 * реклама. Отличие передаётся и словом тоже — подписью «наш ответ», иначе
 * смысл нёс бы один цвет рамки.
 */
export function AnswerCard({
  l,
  titleKey,
  bodyKey,
  ours = false,
  ourLabelKey,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly ours?: boolean;
  readonly ourLabelKey?: string;
}): ReactNode {
  return (
    <div className={`outcome${ours ? ' outcome--ours' : ''}`}>
      <span className="outcome__title">{t(l.dict, titleKey)}</span>
      {ours && ourLabelKey !== undefined ? (
        <span className="badge badge--ok">
          <StatusDot tone="ok" />
          {t(l.dict, ourLabelKey)}
        </span>
      ) : null}
      <span className="outcome__body">{t(l.dict, bodyKey)}</span>
    </div>
  );
}

/** Шаг сценария: номер, короткое имя, одно предложение о том, что происходит. */
export function StepCard({
  l,
  no,
  titleKey,
  bodyKey,
}: {
  readonly l: L10n;
  readonly no: string;
  readonly titleKey: string;
  readonly bodyKey: string;
}): ReactNode {
  return (
    <div className="step">
      <span className="step__no">{no}</span>
      <h3 className="step__title">{t(l.dict, titleKey)}</h3>
      <span>{t(l.dict, bodyKey)}</span>
    </div>
  );
}

/** Перечень утверждений с индикатором: смысл несёт слово, точка — фигуру. */
export function MarkedList({
  l,
  tone,
  keys,
}: {
  readonly l: L10n;
  readonly tone: 'ok' | 'warn' | 'info';
  readonly keys: readonly string[];
}): ReactNode {
  return (
    <div className="security__list">
      {keys.map((key) => (
        <p className="security__item" key={key}>
          <StatusDot tone={tone} />
          <span>{t(l.dict, key)}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Вопрос и ответ. Вопрос, ответ на который ещё пишет юрист, **не показывается
 * вовсе**: вопрос без ответа — это блок, который обещает объяснение и не даёт
 * его, а на странице о чужих деньгах это хуже, чем отсутствие вопроса.
 */
export function PublicQuestion({
  l,
  questionKey,
  answerKey,
}: {
  readonly l: L10n;
  readonly questionKey: string;
  readonly answerKey: string;
}): ReactNode {
  if (legalSlotPending(answerKey) || l.dict[answerKey] === undefined) return null;
  return (
    <Disclosure l={l} summaryKey={questionKey}>
      <p className="muted">{t(l.dict, answerKey)}</p>
    </Disclosure>
  );
}

export interface PublicFieldSpec {
  readonly name: string;
  readonly labelKey: string;
  readonly hintKey: string;
}

/**
 * Форма заявки — единственное действие публичных страниц.
 *
 * ## Три решения, которые видно в разметке
 *
 * 1. **Поля без `name`.** Форма работает без скрипта (`method="get"`), а
 *    приёмника заявок в продукте ещё нет: именованные поля уехали бы в адресную
 *    строку, то есть персональные данные попали бы в историю браузера, в
 *    журналы сервера и в реферер. Отправляется только шаг (`state=sent`).
 *    Это сказано и читателю — строкой `landing.form.draftNote`, а не только
 *    здесь.
 * 2. **Ничего лишнего не спрашиваем.** Паспортных данных и документов на
 *    публичной странице нет: проверка личности живёт после согласий и внутри
 *    сервиса (`LANDING.md` §7).
 * 3. **Текст согласия — ⚖-слот.** Пока юрист не дал формулировку, слот не
 *    рендерится. ⚠ До неё форма не уходит в прод: согласие собирается **до**
 *    обработки (И11.3), и это открытый пункт, а не сделанный.
 */
export function PublicForm({
  l,
  action,
  titleKey,
  noteKey,
  fields,
  submitKey,
  supportKey,
  consentSlotKey,
}: {
  readonly l: L10n;
  readonly action: string;
  readonly titleKey: string;
  readonly noteKey: string;
  readonly fields: readonly PublicFieldSpec[];
  readonly submitKey: string;
  readonly supportKey?: string;
  readonly consentSlotKey: string;
}): ReactNode {
  return (
    <section aria-labelledby="request-title" className="card" id="request">
      <h2 className="card__title" id="request-title">
        {t(l.dict, titleKey)}
      </h2>
      <p className="muted">{t(l.dict, noteKey)}</p>
      <form action={action} className="form" method="get">
        {fields.map((field) => (
          <FormField
            hintKey={field.hintKey}
            key={field.name}
            l={l}
            labelKey={field.labelKey}
            name={field.name}
          >
            <input
              aria-describedby={`${field.name}-hint`}
              autoComplete="off"
              className="fld"
              id={field.name}
              type="text"
            />
          </FormField>
        ))}
        <p className="actions">
          <button className="btn" name="state" type="submit" value="sent">
            {t(l.dict, submitKey)}
          </button>
        </p>
      </form>
      {legalSlotPending(consentSlotKey) || l.dict[consentSlotKey] === undefined ? null : (
        <p className="legal__body">{t(l.dict, consentSlotKey)}</p>
      )}
      <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, 'landing.form.draftNote')}
      </p>
      {supportKey === undefined ? null : (
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, supportKey)}
        </p>
      )}
    </section>
  );
}

/** Заявка принята: что дальше, когда ответ и чего **не** будет. */
export function RequestSent({ l }: { readonly l: L10n }): ReactNode {
  return (
    <section aria-labelledby="sent" className="empty empty--positive">
      <h2 id="sent">{t(l.dict, 'landing.sent.title')}</h2>
      <p className="muted">{t(l.dict, 'landing.sent.body')}</p>
      <p className="muted">{t(l.dict, 'landing.sent.never')}</p>
    </section>
  );
}

/**
 * Приём заявок остановлен.
 *
 * Состояние существует не ради полноты: приём новых сделок останавливается
 * автоматически при нарушении покрытия клиентских средств (красная линия №3,
 * Ф17). Форма, которая в этот момент продолжает собирать заявки, собирает то,
 * на что никто не ответит. Причина названа честно и без раскрытия инцидента.
 */
export function IntakePaused({ l }: { readonly l: L10n }): ReactNode {
  return (
    <section aria-labelledby="paused" className="empty">
      <h2 id="paused">{t(l.dict, 'landing.paused.title')}</h2>
      <p className="muted">{t(l.dict, 'landing.paused.body')}</p>
    </section>
  );
}
