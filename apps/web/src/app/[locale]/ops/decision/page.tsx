import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { getOpsQueue } from '@/fixtures/store';
import { taskHref } from '@/ui/ops-work';

/**
 * Прежний раздел «Решение о выплате» — теперь **не раздел, а задача**.
 *
 * Экрана, живущего рядом с очередью и показывающего одну и ту же сделку всегда,
 * в консоли больше нет: он и был той самой навигацией по сущностям, из-за
 * которой оператор искал работу сам (`CABINETS.md` §5.1). Адрес сохранён, чтобы
 * закладки и обход интерфейса не упирались в 404, и ведёт туда, где решение
 * теперь принимается, — в карточку задачи на утверждение выплаты.
 */
export default async function DecisionRedirect({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const ops = await getOpsQueue();
  const task = ops.tasks.find((item) => item.type === 'approvePayout');
  redirect(task === undefined ? `/${locale}/ops` : taskHref(locale, task.id));
}
