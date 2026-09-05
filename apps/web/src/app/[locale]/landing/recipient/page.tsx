import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DEFAULT_LOCALE, isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import {
  IntakePaused,
  MarkedList,
  PublicForm,
  PublicHead,
  PublicQuestion,
  PublicSection,
  RequestSent,
  type PublicFieldSpec,
} from '@/ui/landing';
import { intakeOpen, intakeState } from '@/view/landing-intake';

/**
 * Страница второй стороны — той, что получает деньги (`LANDING.md` §6.2, П1–П6).
 *
 * ## Почему это отдельный адрес, а не раздел внизу лендинга
 *
 * Расчёт через сервис возможен, только если вторая сторона согласилась, — а
 * убеждает её не страница, а документ, который ей переслали. Раздел внизу чужой
 * страницы никто не перешлёт, и читатель, попавший на текст, написанный не для
 * него, решает, что от него что-то скрыли.
 *
 * Поэтому: отдельный адрес, читается без входа, печатается одним документом.
 *
 * ## Что здесь запрещено
 *
 * Обещания неотзывности в любой формулировке; слов, из которых следует, что
 * деньги «уже не у плательщика»; сравнения с банковским продуктом. До расчёта
 * деньги остаются собственностью второй стороны, и страница говорит это **в
 * начале**, а не третьим абзацем: читают первое предложение, а не третье.
 *
 * ## Печать
 *
 * Блок подтверждения средств и блок честной границы лежат в одном контейнере
 * `.pubdoc`, который запрещено разрывать при печати: разрыв страницы между ними
 * превращает документ в обещание.
 */
const NEED = ['1', '2', '3'] as const;

const FIELDS: readonly PublicFieldSpec[] = Object.freeze([
  { name: 'contact', labelKey: 'landing.form.contact.label', hintKey: 'landing.form.contact.hint' },
]);

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dict = dictionaryOf(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return {
    title: t(dict, 'landing.recipient.title'),
    description: t(dict, 'landing.recipient.what.body'),
  };
}

export default async function RecipientPage({
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

  return (
    <>
      <PublicHead
        eyebrowKey="landing.recipient.eyebrow"
        l={l}
        leadKey="landing.recipient.intro"
        titleKey="landing.recipient.title"
      />

      <PublicSection id="how" l={l} titleKey="landing.recipient.what.title">
        <p className="muted">{t(l.dict, 'landing.recipient.what.body')}</p>
      </PublicSection>

      {/* Подтверждение средств и честная граница — один документ. При печати
          контейнер не разрывается: лист с подтверждением без листа с границей
          читается как обещание платежа, которого мы не даём. */}
      <div className="pubdoc">
        <PublicSection id="assurance" l={l} titleKey="landing.recipient.assurance.title">
          <p className="muted">{t(l.dict, 'landing.recipient.assurance.body')}</p>
          <p className="muted">{t(l.dict, 'landing.recipient.assurance.note')}</p>
        </PublicSection>

        <PublicSection id="boundary" l={l} titleKey="landing.recipient.boundary.title">
          <p className="muted">{t(l.dict, 'landing.recipient.boundary.body')}</p>
          {/* Дословная строка кабинета, а не пересказ: обещание, которого мы не
              даём, формулируется одинаково на всех наших поверхностях. */}
          <MarkedList keys={['trust.weDoNot.6']} l={l} tone="warn" />
        </PublicSection>
      </div>

      <PublicSection id="need" l={l} titleKey="landing.recipient.need.title">
        <MarkedList keys={NEED.map((key) => `landing.recipient.need.${key}`)} l={l} tone="ok" />
      </PublicSection>

      <PublicSection id="when" l={l} titleKey="landing.recipient.when.title">
        <p className="muted">{t(l.dict, 'landing.recipient.when.body')}</p>
        <p className="muted">{t(l.dict, 'landing.recipient.when.late')}</p>
        {/* Сроки реестра и банка названы чужими той же строкой, что в кабинете. */}
        <MarkedList keys={['trust.weDoNot.4']} l={l} tone="warn" />
      </PublicSection>

      <PublicSection id="faq" l={l} titleKey="landing.recipient.faq.title">
        <PublicQuestion
          answerKey="landing.recipient.faq.direct.a"
          l={l}
          questionKey="landing.recipient.faq.direct.q"
        />
        <PublicQuestion
          answerKey="landing.recipient.faq.revoke.a"
          l={l}
          questionKey="landing.recipient.faq.revoke.q"
        />
        <PublicQuestion
          answerKey="landing.recipient.faq.cost.a"
          l={l}
          questionKey="landing.recipient.faq.cost.q"
        />
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
          action={`/${locale}/landing/recipient`}
          consentSlotKey="landing.legal.consent"
          fields={FIELDS}
          l={l}
          noteKey="landing.recipient.contact.note"
          submitKey="landing.form.submit"
          supportKey="landing.form.support"
          titleKey="landing.recipient.contact.title"
        />
      )}
    </>
  );
}
