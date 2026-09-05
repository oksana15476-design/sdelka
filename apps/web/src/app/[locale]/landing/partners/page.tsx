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
  PublicSection,
  RequestSent,
  type PublicFieldSpec,
} from '@/ui/landing';
import { intakeOpen, intakeState } from '@/view/landing-intake';

/**
 * Партнёрская страница (`LANDING.md` §6.3, А1–А4) — намеренно минимальная.
 *
 * ## Почему на ней нет самого сильного аргумента
 *
 * Сильнейший довод для агента — вознаграждение, которое приходит вместе с
 * деньгами получателя. Механики расщепления в продукте нет (E17-3 не сделана),
 * груминг ролей агента и застройщика не проведён (E17-1). Обещать
 * неимплементированное поведение запрещено, поэтому страница на Г1 слабая, и
 * цена этого решения названа прямо, а не спрятана.
 *
 * Страница говорит ровно два факта — что делает сервис и что мы ищем партнёров
 * на пилот — и ведёт на разговор. Всё остальное — переговоры, а не страница.
 */
const NO_PROMISE = ['1', '2', '3'] as const;

const FIELDS: readonly PublicFieldSpec[] = Object.freeze([
  { name: 'who', labelKey: 'landing.partner.form.who.label', hintKey: 'landing.partner.form.who.hint' },
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
    title: t(dict, 'landing.partner.title'),
    description: t(dict, 'landing.partner.what.body'),
  };
}

export default async function PartnersPage({
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
        eyebrowKey="landing.partner.eyebrow"
        l={l}
        leadKey="landing.partner.what.body"
        titleKey="landing.partner.title"
      />

      <PublicSection id="seek" l={l} titleKey="landing.partner.seek.title">
        <p className="muted">{t(l.dict, 'landing.partner.seek.body')}</p>
      </PublicSection>

      {/* Чего мы не обещаем сегодня — раньше, чем что-либо о выгоде: партнёр,
          прочитавший обещание и не нашедший его в продукте, стоит дороже, чем
          партнёр, не пришедший вовсе. */}
      <PublicSection id="no-promise" l={l} titleKey="landing.partner.noPromise.title">
        <MarkedList keys={NO_PROMISE.map((key) => `landing.partner.noPromise.${key}`)} l={l} tone="warn" />
        <p className="muted">{t(l.dict, 'landing.partner.limit')}</p>
      </PublicSection>

      {/* Границу обещания партнёр читает теми же словами, что клиент: строки
          кабинета, а не пересказ для внутреннего употребления. */}
      <PublicSection id="we-do-not" l={l} titleKey="trust.weDoNot.title">
        <MarkedList keys={['trust.weDoNot.5', 'trust.weDoNot.6']} l={l} tone="warn" />
        <p className="muted">{t(l.dict, 'trust.boundary')}</p>
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
          action={`/${locale}/landing/partners`}
          consentSlotKey="landing.legal.consent"
          fields={FIELDS}
          l={l}
          noteKey="landing.partner.form.note"
          submitKey="landing.partner.form.submit"
          titleKey="landing.partner.form.title"
        />
      )}
    </>
  );
}
