import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { getDeal, now, verifyUrl, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Badge, Banner, ErrorState, SecurityBlock } from '@/ui/primitives';
import {
  AssuranceCard,
  AssuranceLadder,
  DealTimeline,
  MoneyCard,
  MoneyStateCard,
  PropertyAndParties,
  RequiredActionCard,
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
      <>
        <ErrorState l={l} titleKey="deal.error.title" caseId="SD-CASE-8120" />
        <SecurityBlock l={l} />
      </>
    );
  }

  if (screenState === 'denied') {
    return (
      <>
        <div className="card" role="alert">
          <h1>{t(l.dict, 'deal.denied.title')}</h1>
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'deal.denied.body')}
          </p>
        </div>
        <SecurityBlock l={l} />
      </>
    );
  }

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}`}>
          {t(l.dict, 'deal.backToList')}
        </a>
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
        <div className="pagehead__row">
          <h1>{deal.property.addressLatin}</h1>
          <Badge
            tone={deal.role === 'paying' ? 'info' : 'refund'}
            label={t(l.dict, `deals.role.${deal.role}`)}
          />
        </div>
        <p className="pagehead__note">
          <span className="mono">{deal.ref}</span> {deal.property.address}
        </p>
      </div>

      {deal.role === 'paying' ? (
        <>
          <MoneyStateCard {...view} />
          <MoneyCard l={l} deal={deal} />
          {screenState === 'partial' ? (
            <section className="card">
              <h2 className="card__title">{t(l.dict, 'deal.timeline.heading')}</h2>
              <p className="muted">{t(l.dict, 'deal.timeline.unavailable')}</p>
              <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
                <a className="btn btn--ghost" href={`/${locale}/deals/${deal.id}`}>
                  {t(l.dict, 'error.retry')}
                </a>
              </p>
            </section>
          ) : (
            <DealTimeline {...view} />
          )}
          <PropertyAndParties {...view} />
        </>
      ) : (
        <>
          <RequiredActionCard l={l} deal={deal} />
          <AssuranceCard {...view} verifyUrl={verifyUrl()} />
          <AssuranceLadder l={l} deal={deal} />
          <DealTimeline {...view} />
          <PropertyAndParties {...view} />
        </>
      )}

      <SecurityBlock l={l} />
    </>
  );
}
