import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { DEFAULT_LOCALE, LOCALES } from '@/i18n/locales';

/**
 * Язык живёт в маршруте, а не в куке: ссылку на экран сделки можно переслать, и
 * получатель увидит её на том же языке. Геолокацией язык не выбирается ни при
 * каких условиях — только выбором пользователя (`SCREENS.md` §1.1).
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasLocale = LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) {
    // Путь передаётся дальше заголовком: каркас обязан знать, рисует он кабинет
    // клиента или консоль операций, а сегмент маршрута до корневого макета не
    // доходит. Консоль не показывает клиентскую навигацию — это разные рабочие
    // места, а не два вида одного.
    const headers = new Headers(request.headers);
    headers.set('x-sdelka-path', pathname);
    return NextResponse.next({ request: { headers } });
  }
  const url = request.nextUrl.clone();
  url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next|favicon.ico|screenshots).*)'],
};
