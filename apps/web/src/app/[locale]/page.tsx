import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatDateTime } from '@/i18n/format';
import { listDeals, now, viewerName, viewerTimeZone } from '@/fixtures/store';
import { Amount, Badge, EmptyState, ErrorState, SecurityBlock } from '@/ui/primitives';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';

/**
 * Экран 1 — список сделок.
 *
 * Один список на клиента, обе роли вместе. Переключателя режимов нет: у каждой
 * строки написано, платит клиент по этой сделке или получает, и открывается она
 * тем видом, который следует из роли **в этой сделке** (`ROADMAP.md` И5.0).
 */
export default async function DealsPage({
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
  const deals = await listDeals();
  const viewerZone = viewerTimeZone();
  const currentTime = now();

  if (screenState === 'error') {
    return (
      <div className="shell stack">
        <ErrorState l={l} titleKey="deals.error.title" caseId="SD-CASE-4471" />
        <SecurityBlock l={l} />
      </div>
    );
  }

  return (
    <div className="shell--wide shell stack--loose stack">
      <div className="pagehead">
        <h1>{t(l.dict, 'deals.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'deals.subtitle', { name: viewerName() })}</p>
        {screenState === 'ready' ? (
          <p className="faint">{plural(l.dict, locale, 'deals.count', deals.length)}</p>
        ) : null}
      </div>

      {screenState === 'empty' ? (
        <EmptyState l={l} titleKey="deals.empty.title" bodyKey="deals.empty.body" />
      ) : null}

      {screenState === 'loading' ? (
        <ul className="deal-list">
          {[0, 1, 2].map((index) => (
            <li className="deal-card" key={index} aria-hidden="true">
              <span className="skeleton" style={{ minInlineSize: '14ch' }} />
              <span className="skeleton" style={{ minInlineSize: '22ch' }} />
              <span className="skeleton" style={{ minInlineSize: '10ch' }} />
            </li>
          ))}
        </ul>
      ) : null}

      {screenState === 'ready' ? (
        <ul className="deal-list">
          {deals.map((deal) => (
            <li className="deal-card" key={deal.id}>
              <div className="deal-card__main">
                <div className="deal-card__top">
                  <Badge
                    tone={deal.role === 'paying' ? 'info' : 'action'}
                    label={t(l.dict, `deals.role.${deal.role}`)}
                  />
                  <span className="deal-card__meta">
                    <span className="mono">{deal.ref}</span>
                  </span>
                </div>
                <h2 className="deal-card__title">
                  <a href={`/${locale}/deals/${deal.id}`}>{deal.property.addressLatin}</a>
                </h2>
                <p className="deal-card__meta">{deal.property.address}</p>
              </div>
              <div className="deal-card__status">
                <Badge
                  tone={deal.tone}
                  label={t(l.dict, `deals.state.${deal.moneyState}.${deal.role}`)}
                />
                {deal.deadline === null ? (
                  <p className="faint">{t(l.dict, 'deals.noDeadline')}</p>
                ) : deal.deadline.at === null ? (
                  <p className="faint">{t(l.dict, 'deadline.paused.title')}</p>
                ) : (
                  <p className="faint">
                    {t(l.dict, 'deals.until', {
                      value: formatDateTime(locale, deal.deadline.at, OPERATIONS_TIME_ZONE),
                    })}
                  </p>
                )}
              </div>
              <div className="deal-card__money">
                <Amount l={l} value={deal.required} size="lead" labelKey="deals.amountLabel" />
              </div>
              <p>
                <a className="btn btn--secondary" href={`/${locale}/deals/${deal.id}`}>
                  {t(l.dict, 'deals.open')}
                </a>
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="faint">
        {t(l.dict, 'common.timeZoneNote', {
          zone: viewerZone,
          value: formatDateTime(locale, currentTime, viewerZone),
        })}
      </p>

      <SecurityBlock l={l} />
    </div>
  );
}
