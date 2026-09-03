import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { type Locale, LOCALE_DIRECTION, LOCALES, isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { AppHeader } from '@/ui/chrome';
import '@/styles/app.css';

export function generateStaticParams(): { locale: Locale }[] {
  return LOCALES.map((locale) => ({ locale }));
}

export const metadata = {
  title: 'Sdelka',
};

/**
 * Корневой каркас. Один кабинет на клиента: ни списка режимов, ни выбора роли —
 * роль определяется сделкой, а не интерфейсом (`CABINETS.md` §4).
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  const l = { dict: dictionaryOf(locale), locale };
  const path = (await headers()).get('x-sdelka-path') ?? '';
  const console = path.includes('/ops');
  return (
    <html lang={locale} dir={LOCALE_DIRECTION[locale]}>
      <body>
        <div className="page">
          <AppHeader l={l} variant={console ? 'console' : 'client'} />
          <main className="main">{children}</main>
          <footer className="footer">
            <div className="footer__inner">
              <nav className="footer__links" aria-label={t(l.dict, 'nav.secondary')}>
                {console ? (
                  <a href={`/${locale}`}>{t(l.dict, 'nav.deals')}</a>
                ) : (
                  <>
                    <a href={`/${locale}/security`}>{t(l.dict, 'nav.security')}</a>
                    <a href={`/${locale}/ops`}>{t(l.dict, 'nav.console')}</a>
                  </>
                )}
              </nav>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
