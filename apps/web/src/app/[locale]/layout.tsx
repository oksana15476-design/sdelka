import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { type Locale, LOCALE_DIRECTION, LOCALES, isLocale } from '@/i18n/locales';
import { dictionaryOf } from '@/i18n/translate';
import { AppShell } from '@/ui/chrome';
import { viewerCard } from '@/fixtures/store';
import { getNotifications, unreadCount } from '@/fixtures/screens';
import '@/styles/app.css';

export function generateStaticParams(): { locale: Locale }[] {
  return LOCALES.map((locale) => ({ locale }));
}

export const metadata = {
  title: 'Reestra',
};

/**
 * Корневой каркас. Один кабинет на клиента: ни списка режимов, ни выбора роли —
 * роль определяется сделкой, а не интерфейсом (`CABINETS.md` §4).
 *
 * Консоль операций — другое рабочее место: у неё своя навигация и своя ширина
 * содержимого, и клиентские разделы в ней не показываются вовсе.
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
  const path = (await headers()).get('x-sdelka-path') ?? `/${locale}`;
  const console = path.includes('/ops');
  const unread = console ? 0 : unreadCount(await getNotifications());
  return (
    <html lang={locale} dir={LOCALE_DIRECTION[locale]}>
      <body>
        <AppShell
          l={l}
          path={path}
          viewer={viewerCard()}
          variant={console ? 'console' : 'client'}
          unread={unread}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
