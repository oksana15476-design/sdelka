import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { type Locale, DEFAULT_LOCALE, LOCALE_DIRECTION, LOCALES, isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { AppShell } from '@/ui/chrome';
import { viewerCard } from '@/fixtures/store';
import { getNotifications, unreadCount } from '@/fixtures/screens';
import '@/styles/app.css';

export function generateStaticParams(): { locale: Locale }[] {
  return LOCALES.map((locale) => ({ locale }));
}

/**
 * Заголовок вкладки — из словаря, а не из литерала.
 *
 * Он печатается в четырёх местах, которые язык обязан различать: вкладка
 * браузера, закладка, история и превью при отправке ссылки. Литерал `Reestra`
 * давал латиницу и на грузинской версии, хотя в словаре у `app.brand` стоит
 * `რეესტრა`. Правило «ни одной строки текста в коде» на `metadata`
 * распространяется ровно так же, как на разметку.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const dict = dictionaryOf(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return {
    title: { default: t(dict, 'app.brand'), template: `%s · ${t(dict, 'app.brand')}` },
    description: t(dict, 'app.tagline'),
  };
}

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
  // Кабинет владельца — своё рабочее место со своей навигацией: разделов
  // консоли в нём нет, и счётчика клиентских уведомлений тоже (E16-1).
  const owner = path.includes('/owner');
  const unread = console || owner ? 0 : unreadCount(await getNotifications());
  return (
    <html lang={locale} dir={LOCALE_DIRECTION[locale]}>
      <body>
        <AppShell
          l={l}
          path={path}
          viewer={viewerCard()}
          variant={console ? 'console' : owner ? 'owner' : 'client'}
          unread={unread}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
