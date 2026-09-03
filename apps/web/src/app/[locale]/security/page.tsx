import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { SecurityBlock } from '@/ui/primitives';

/** Развёрнутый раздел безопасности: сюда ведёт действие «сообщить о контакте». */
export default async function SecurityPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  return (
    <div className="shell stack--loose stack">
      <div className="pagehead">
        <h1>{t(l.dict, 'security.page.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'security.page.subtitle')}</p>
      </div>
      <SecurityBlock l={l} variant="inline" />
      <section className="card">
        <h2 className="card__title">{t(l.dict, 'security.report.title')}</h2>
        <p className="muted">{t(l.dict, 'security.report.body')}</p>
      </section>
    </div>
  );
}
