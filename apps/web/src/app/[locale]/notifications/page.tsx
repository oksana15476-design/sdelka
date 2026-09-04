import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDateTime } from '@/i18n/format';
import { viewerTimeZone } from '@/fixtures/store';
import { getNotifications } from '@/fixtures/screens';
import { EmptyState, Eyebrow, SecurityBlock, StatusDot } from '@/ui/primitives';

/**
 * Уведомления. Список существует ровно затем, чтобы письмо можно было
 * проверить: письмо могло не дойти или быть подделано, а этот список настоящий.
 *
 * Уведомление никогда не содержит реквизитов и не ведёт прямо в действие —
 * только на экран сделки.
 */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const screenState = typeof query.state === 'string' ? query.state : 'ready';
  const l = { dict: dictionaryOf(locale), locale };
  const items = await getNotifications();
  const viewerZone = viewerTimeZone();

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'notifications.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'notifications.subtitle')}</p>
      </div>

      {screenState === 'empty' || items.length === 0 ? (
        <EmptyState l={l} titleKey="notifications.empty.title" bodyKey="notifications.empty.body" />
      ) : (
        <section className="card">
          <h2 className="card__title">{t(l.dict, 'notifications.list.title')}</h2>
          <ul>
            {items.map((item) => (
              <li className="record" key={item.id}>
                <div className="record__top">
                  <span className="record__label">
                    <StatusDot tone={item.tone === 'ok' ? 'ok' : item.tone === 'warn' ? 'warn' : 'info'} />{' '}
                    {t(l.dict, `notifications.item.${item.id}.title`)}
                  </span>
                  <span className="record__meta">{formatDateTime(locale, item.at, viewerZone)}</span>
                </div>
                <p className="muted">{t(l.dict, `notifications.item.${item.id}.body`)}</p>
                <span className="record__meta">
                  <a href={`/${locale}/deals/${item.dealId}`}>
                    <span className="mono">{item.dealRef}</span>
                  </a>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="notifications.rule.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'notifications.rule.body')}
        </p>
      </section>

      <SecurityBlock l={l} />
    </>
  );
}
