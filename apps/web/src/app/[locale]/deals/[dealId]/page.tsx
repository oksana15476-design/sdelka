import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { getDeal, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Badge, Banner, DeadlineTimer, ErrorState, SecurityBlock } from '@/ui/primitives';
import {
  AssuranceLadder,
  DealTimeline,
  FundsAssuranceCard,
  MoneyCard,
  MoneyLocation,
  PartiesAndDocs,
  PrimaryActionBlock,
  PropertyCard,
} from '@/ui/deal';

/**
 * Экраны 2 и 3 — сделка. Один маршрут, два вида.
 *
 * Вид выбирается ролью клиента **в этой сделке**, а не переключателем: сделка
 * сама знает, платит он по ней или получает (`CABINETS.md` §4, `ROADMAP.md`
 * И5.0). Поэтому здесь нет ни одного места, где пользователь выбирает роль.
 */
export default async function DealPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly dealId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale, dealId } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const screenState = typeof query.state === 'string' ? query.state : 'ready';
  const l = { dict: dictionaryOf(locale), locale };
  const deal = await getDeal(dealId);
  if (deal === null) notFound();
  const currentTime = now();
  const viewerZone = viewerTimeZone();
  const view = { l, deal, now: currentTime, operationsZone: OPERATIONS_TIME_ZONE, viewerZone };

  if (screenState === 'error') {
    return (
      <div className="shell stack">
        <ErrorState l={l} titleKey="deal.error.title" caseId="SD-CASE-8120" />
        <SecurityBlock l={l} />
      </div>
    );
  }

  if (screenState === 'denied') {
    return (
      <div className="shell stack">
        <div className="card" role="alert">
          <h1>{t(l.dict, 'deal.denied.title')}</h1>
          <p className="muted">{t(l.dict, 'deal.denied.body')}</p>
        </div>
        <SecurityBlock l={l} />
      </div>
    );
  }

  return (
    <div className="shell stack">
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a href={`/${locale}`}>{t(l.dict, 'deal.backToList')}</a>
      </nav>

      {deal.modifiers.coverageBreach ? (
        <Banner tone="critical" titleKey="banner.coverage.title" bodyKey="banner.coverage.body" l={l} />
      ) : null}
      {deal.modifiers.requisitesCooling ? (
        <Banner tone="warn" titleKey="banner.cooling.title" bodyKey="banner.cooling.body" l={l} />
      ) : null}
      {deal.modifiers.quoteExpired ? (
        <Banner tone="warn" titleKey="banner.quote.title" bodyKey="banner.quote.body" l={l} />
      ) : null}
      {screenState === 'partial' ? (
        <Banner tone="info" titleKey="banner.partial.title" bodyKey="banner.partial.body" l={l} />
      ) : null}

      <div className="pagehead">
        <div className="deal-card__top">
          <Badge
            tone={deal.role === 'paying' ? 'info' : 'action'}
            label={t(l.dict, `deals.role.${deal.role}`)}
          />
          <span className="deal-card__meta">
            <span className="mono">{deal.ref}</span>
          </span>
        </div>
        {deal.role === 'paying' ? <h1>{deal.property.addressLatin}</h1> : null}
        <p className="pagehead__note">{deal.property.address}</p>
      </div>

      {deal.role === 'paying' ? (
        <>
          <MoneyLocation l={l} deal={deal} />
          <PrimaryActionBlock l={l} deal={deal} />
          {deal.deadline === null ? (
            <section className="card">
              <h2 className="card__title">{t(l.dict, 'deadline.heading')}</h2>
              <p className="muted">{t(l.dict, 'deadline.none')}</p>
            </section>
          ) : (
            <section className="card">
              <h2 className="card__title">{t(l.dict, 'deadline.heading')}</h2>
              <DeadlineTimer
                l={l}
                deadline={deal.deadline}
                now={currentTime}
                operationsZone={OPERATIONS_TIME_ZONE}
                viewerZone={viewerZone}
              />
            </section>
          )}
          <MoneyCard l={l} deal={deal} />
          {screenState === 'partial' ? (
            <section className="card">
              <h2 className="card__title">{t(l.dict, 'deal.timeline.heading')}</h2>
              <p className="muted">{t(l.dict, 'deal.timeline.unavailable')}</p>
              <p className="actions">
                <a className="btn btn--ghost" href={`/${locale}/deals/${deal.id}`}>
                  {t(l.dict, 'error.retry')}
                </a>
              </p>
            </section>
          ) : (
            <DealTimeline {...view} />
          )}
          <PropertyCard {...view} />
          <PartiesAndDocs l={l} deal={deal} />
        </>
      ) : (
        <>
          <AssuranceLadder l={l} deal={deal} />
          <FundsAssuranceCard {...view} />
          <PrimaryActionBlock l={l} deal={deal} />
          <DealTimeline {...view} />
          <PropertyCard {...view} />
          <PartiesAndDocs l={l} deal={deal} />
        </>
      )}

      <SecurityBlock l={l} />
    </div>
  );
}
