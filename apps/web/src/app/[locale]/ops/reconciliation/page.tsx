import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/locales';

/**
 * Прежний раздел «Сверка и покрытие» разошёлся на две разные вещи.
 *
 * Разбор расхождения — **задача**, и живёт она в очереди наравне с остальными.
 * Покрытие клиентских средств и журнал проводок — то, на что смотрят целиком
 * каждое утро, и это дежурный дашборд (`CABINETS.md` §5.4). Держать их одним
 * разделом значило делать вид, что это одна работа: первая ждёт человека,
 * вторая не ждёт никого.
 */
export default async function ReconciliationRedirect({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/${locale}/ops/duty`);
}
