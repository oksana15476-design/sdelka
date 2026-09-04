import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { getOpsQueue } from '@/fixtures/store';
import { unfreezeTargetOf } from '@/fixtures/screens';
import { taskHref } from '@/ui/ops-work';

/**
 * Прежний раздел «Снятие приостановки» — теперь задача в общей очереди.
 *
 * Выбранная цель разморозки переносится в адрес карточки: цель — обязательное
 * поле события, а не вывод системы (`packages/domain/src/freeze.ts:44`), и
 * терять её на переходе нельзя.
 */
export default async function UnfreezeRedirect({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const target = unfreezeTargetOf(typeof query.target === 'string' ? query.target : undefined);
  const ops = await getOpsQueue();
  const task = ops.tasks.find((item) => item.type === 'reviewSanction');
  redirect(task === undefined ? `/${locale}/ops` : `${taskHref(locale, task.id)}?target=${target}`);
}
