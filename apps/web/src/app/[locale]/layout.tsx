import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { type Locale, DEFAULT_LOCALE, LOCALE_DIRECTION, LOCALES, isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { AppShell } from '@/ui/chrome';
import { PublicShell } from '@/ui/public-chrome';
import { preloadedFonts } from '@/ui/fonts';
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
  /**
   * Публичные страницы — четвёртое место, и оно не кабинет: у него нет ни
   * разделов, ни карточки человека, ни ссылки внутрь продукта. Каркас выбирается
   * по адресу тем же способом, что консоль и кабинет владельца, потому что
   * сегмент маршрута до корневого макета не доходит.
   *
   * Ссылки «войти» здесь нет намеренно: аутентификации в продукте не существует
   * вовсе, а публичная ссылка в кабинет превратила бы известный блокер в
   * эксплуатируемый (`LANDING.md` §6.4, критерий ПЛ9).
   */
  /*
   * Вход и выход идут публичным каркасом, а не каркасом кабинета: показывать
   * разделы кабинета и карточку человека тому, кто ещё не вошёл, — это
   * навигация в места, куда он не пройдёт, плюс данные, которых у нас о нём
   * пока нет. Ссылки «войти» на публичных страницах при этом по-прежнему нет:
   * она появится вместе с текстом, прошедшим копирайтера и главреда
   * (`ui/copy.ts`, перечень `signIn.*`).
   */
  const isPublic =
    path.startsWith(`/${locale}/landing`) ||
    path === `/${locale}/login` ||
    path === `/${locale}/logout`;
  const console = path.includes('/ops');
  // Кабинет владельца — своё рабочее место со своей навигацией: разделов
  // консоли в нём нет, и счётчика клиентских уведомлений тоже (E16-1).
  const owner = path.includes('/owner');
  const unread = console || owner || isPublic ? 0 : unreadCount(await getNotifications());
  return (
    <html lang={locale} dir={LOCALE_DIRECTION[locale]}>
      <head>
        {/* Шрифты лежат рядом с приложением, но `crossorigin` обязателен и для
            своего домена: без него браузер загрузит файл дважды — один раз по
            предзагрузке, второй раз по правилу `@font-face`, которое всегда
            идёт в режиме CORS. */}
        {preloadedFonts(locale).map((href) => (
          <link as="font" crossOrigin="anonymous" href={href} key={href} rel="preload" type="font/woff2" />
        ))}
      </head>
      <body>
        {isPublic ? (
          <PublicShell l={l} path={path}>
            {children}
          </PublicShell>
        ) : (
          <AppShell
            l={l}
            path={path}
            viewer={viewerCard()}
            variant={console ? 'console' : owner ? 'owner' : 'client'}
            unread={unread}
          >
            {children}
          </AppShell>
        )}
      </body>
    </html>
  );
}
