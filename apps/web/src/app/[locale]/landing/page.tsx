import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import {
  AnswerCard,
  FactCard,
  IntakePaused,
  MarkedList,
  PublicForm,
  PublicHead,
  PublicQuestion,
  PublicSection,
  RequestSent,
  StepCard,
  type PublicFieldSpec,
} from '@/ui/landing';
import { LegalSlot, StatusDot, legalSlotPending } from '@/ui/primitives';
import { intakeOpen, intakeState } from '@/view/landing-intake';

/**
 * Публичная страница для того, кто вносит деньги (`LANDING.md` §6.1, блоки Л1–Л13).
 *
 * ## Чей страх снимается первым
 *
 * Покупателя, и это не выбор между двумя равными страхами: его страх снимается
 * внешним фактом целиком, а страх второй стороны — только частично, потому что
 * до расчёта деньги остаются собственностью плательщика и отзывны. Страница,
 * ведущая страхом получателя, вынуждена обещать больше, чем даёт конструкция.
 *
 * ## Чего на странице нет и почему
 *
 * Отзывов, кейсов, логотипов, счётчиков сделок и объёмов — их нет в продукте,
 * а пустое место честнее выдуманного. Обещаний скорости — срок держат реестр и
 * банк. Слова, которое запрещено красной линией №10, — нет ни в тексте, ни в
 * заголовке вкладки, ни в описании страницы, ни в адресе. Кнопки «войти» — её
 * появление относится к работе над аутентификацией, а не над лендингом.
 *
 * ## Что ждёт человека
 *
 * Весь текст — черновик (`PENDING_COPY_KEYS`), связка копирайтер → главред его
 * не смотрела. Блок статуса «кто мы» (Л6), три правила Ю-25 (Л10), ответы «а вы
 * кто такие» и «что если вы закроетесь», цена и текст согласия формы —
 * ⚖-слоты: пока их не напишет юрист, на экране их **нет**.
 */
const STEPS = ['1', '2', '3', '4', '5'] as const;

const NOT_FOR = ['1', '2', '3', '4'] as const;

const YOU_NEED = ['1', '2', '3', '4'] as const;

const WE_DO_NOT = ['1', '2', '3', '4', '5', '6'] as const;

const FIELDS: readonly PublicFieldSpec[] = Object.freeze([
  { name: 'contact', labelKey: 'landing.form.contact.label', hintKey: 'landing.form.contact.hint' },
  { name: 'country', labelKey: 'landing.form.country.label', hintKey: 'landing.form.country.hint' },
  { name: 'amount', labelKey: 'landing.form.amount.label', hintKey: 'landing.form.amount.hint' },
  { name: 'timing', labelKey: 'landing.form.timing.label', hintKey: 'landing.form.timing.hint' },
]);

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dict = dictionaryOf(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return { title: t(dict, 'landing.hero.title'), description: t(dict, 'landing.hero.body') };
}

export default async function LandingPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const raw = query.state;
  const state = intakeState(typeof raw === 'string' ? raw : undefined, intakeOpen());
  const bank = { bank: t(l.dict, 'glossary.custodian') };

  return (
    <>
      <PublicHead
        eyebrowKey="landing.hero.eyebrow"
        l={l}
        leadKey="landing.hero.body"
        titleKey="landing.hero.title"
      >
        {/* Время глаголов: продукт не запущен, и ни одна строка не говорит о
            сервисе в настоящем времени (`LANDING.md` §2.4, критерий ПЛ9). */}
        <p className="hero__stage">
          <StatusDot tone="info" />
          <span>{t(l.dict, 'landing.hero.stage')}</span>
        </p>
        <p className="hero__actions">
          <a className="btn" href="#request">
            {t(l.dict, 'landing.hero.cta')}
          </a>
          {/* Не второе действие, а вспомогательная ссылка: расчёт возможен,
              только если вторая сторона согласилась, и ей нужен отдельный
              пересылаемый адрес, а не якорь внутри этой страницы. */}
          <a className="chipbtn" href={`/${locale}/landing/recipient`}>
            {t(l.dict, 'landing.hero.forward')}
          </a>
        </p>
        <p className="muted">{t(l.dict, 'landing.hero.forward.note')}</p>
      </PublicHead>

      {/* Обещание не переписывается заново: ключ один на сайт и на карту
          рисков. Два текста об одном обещании расходятся молча. */}
      <PublicSection id="promise" l={l} titleKey="landing.promise.title">
        <p className="hero__lead">{t(l.dict, 'risks.promise')}</p>
      </PublicSection>

      <PublicSection id="facts" l={l} titleKey="landing.facts.title">
        <div className="facts">
          <FactCard
            bodyKey="landing.facts.where.body"
            l={l}
            params={bank}
            titleKey="landing.facts.where.title"
          />
          <FactCard bodyKey="landing.facts.trigger.body" l={l} titleKey="landing.facts.trigger.title" />
          <FactCard
            bodyKey="landing.facts.otherwise.body"
            l={l}
            titleKey="landing.facts.otherwise.title"
          />
        </div>
      </PublicSection>

      {/* Главный аргумент и единственный, который работает на обе стороны
          сразу. Обратная сторона — возврат по умолчанию — стоит здесь же, а не
          в мелком шрифте внизу страницы (`LANDING.md` §4.3). */}
      <PublicSection id="decides" l={l} noteKey="landing.decides.note" titleKey="landing.decides.title">
        <div className="outcomes outcomes--three">
          <AnswerCard bodyKey="landing.decides.other.body" l={l} titleKey="landing.decides.other.title" />
          <AnswerCard
            bodyKey="landing.decides.middleman.body"
            l={l}
            titleKey="landing.decides.middleman.title"
          />
          <AnswerCard
            bodyKey="landing.decides.fact.body"
            l={l}
            ourLabelKey="landing.decides.ours"
            ours
            titleKey="landing.decides.fact.title"
          />
        </div>
        <p className="muted">{t(l.dict, 'landing.decides.reverse')}</p>
      </PublicSection>

      <PublicSection id="steps" l={l} titleKey="landing.steps.title">
        <div className="steps">
          {STEPS.map((no) => (
            <StepCard
              bodyKey={`landing.step.${no}.body`}
              key={no}
              l={l}
              no={no}
              titleKey={`landing.step.${no}.title`}
            />
          ))}
        </div>
      </PublicSection>

      <PublicSection id="money" l={l} titleKey="landing.money.title">
        <p className="muted">{t(l.dict, 'landing.money.currency')}</p>
        <p className="muted">{t(l.dict, 'landing.money.rate')}</p>
        <p className="muted">{t(l.dict, 'landing.money.card')}</p>
      </PublicSection>

      {/*
       * Л6 «Где деньги и кто мы». Строка о статусе — заявление о регулируемом
       * статусе и верна ровно с даты его получения (Ю-37, ⛔). Пока юрист не дал
       * формулировку, блок отсутствует целиком, а не заменяется обтекаемой
       * фразой: обтекаемая формулировка о статусе хуже отсутствующей. Где лежат
       * деньги, сказано фактом №1 выше.
       */}
      {legalSlotPending('landing.legal.status') ? null : (
        <PublicSection id="where" l={l} titleKey="landing.where.title">
          <LegalSlot bodyKey="landing.legal.status" l={l} />
        </PublicSection>
      )}

      {/* Чего мы не делаем — дословно те же строки, что в кабинете: блок
          переиспользует `trust.*`, а не заводит второй текст об одном и том же
          (критерий ПЛ3). Ссылка на публичную карту рисков появится вместе с
          самой картой (E10-1): вести её сегодня некуда, а ссылка в кабинет
          запрещена критерием ПЛ9. */}
      <PublicSection id="we-do-not" l={l} titleKey="trust.weDoNot.title">
        <MarkedList keys={WE_DO_NOT.map((key) => `trust.weDoNot.${key}`)} l={l} tone="warn" />
        <p className="muted">{t(l.dict, 'trust.boundary')}</p>
      </PublicSection>

      <PublicSection id="not-for" l={l} noteKey="landing.notFor.note" titleKey="landing.notFor.title">
        <MarkedList keys={NOT_FOR.map((key) => `landing.notFor.${key}`)} l={l} tone="info" />
      </PublicSection>

      <PublicSection id="you-need" l={l} titleKey="landing.youNeed.title">
        <MarkedList keys={YOU_NEED.map((key) => `landing.youNeed.${key}`)} l={l} tone="ok" />
      </PublicSection>

      {/* Л10, три правила Ю-25: возврат только на счёт-источник, платёж от
          третьего лица останавливается, реквизиты не меняются в последние 72
          часа. Это преддоговорная информация, её пишет юрист, и она обязана
          существовать на грузинском. До формулировки блока нет. */}
      {legalSlotPending('landing.legal.rules') ? null : (
        <PublicSection id="rules" l={l} titleKey="landing.rules.title">
          <LegalSlot bodyKey="landing.legal.rules" l={l} />
        </PublicSection>
      )}

      <PublicSection id="faq" l={l} titleKey="landing.faq.title">
        <PublicQuestion answerKey="landing.faq.speed.a" l={l} questionKey="landing.faq.speed.q" />
        <PublicQuestion answerKey="landing.faq.notary.a" l={l} questionKey="landing.faq.notary.q" />
        {/* Три вопроса ждут юриста: кто мы такие, что будет, если мы закроемся,
            и сколько это стоит. Вопрос без ответа не показывается. */}
        <PublicQuestion answerKey="landing.legal.whoWeAre" l={l} questionKey="landing.faq.who.q" />
        <PublicQuestion answerKey="landing.legal.ifWeClose" l={l} questionKey="landing.faq.closed.q" />
        <PublicQuestion answerKey="landing.legal.price" l={l} questionKey="landing.faq.price.q" />
      </PublicSection>

      {state === 'paused' ? (
        <div id="request">
          <IntakePaused l={l} />
        </div>
      ) : state === 'sent' ? (
        <div id="request">
          <RequestSent l={l} />
        </div>
      ) : (
        <PublicForm
          action={`/${locale}/landing`}
          consentSlotKey="landing.legal.consent"
          fields={FIELDS}
          l={l}
          noteKey="landing.form.note"
          submitKey="landing.form.submit"
          supportKey="landing.form.support"
          titleKey="landing.form.title"
        />
      )}
    </>
  );
}
