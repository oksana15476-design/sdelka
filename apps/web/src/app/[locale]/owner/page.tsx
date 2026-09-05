import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import {
  formatBasisPoints,
  formatMonth,
  formatNumber,
} from '@/i18n/format';
import { OWNER_PERIODS, getOwnerSummary, ownerPeriodOf } from '@/fixtures/owner';
import { moneyTone } from '@/view/owner-economics';
import { ROLE_CAPABILITIES } from '@/view/owner-role';
import { Amount, Badge, Banner, EmptyState, Eyebrow, Row } from '@/ui/primitives';

/**
 * Сводка за период — И16.3.
 *
 * Три правила, которые этот экран держит и которые легко потерять:
 *
 * 1. **Единой цифры «всего» нет.** По каждой валюте своя карточка, и строки
 *    «итого по портфелю» нет ни одной. Складывать лари с долларами нечем: курс
 *    — внешний факт на дату, а не свойство отчёта.
 * 2. **Число сделок и число завершённых — разные величины.** Оборот и средний
 *    чек считаются по завершённым; живая и откаченная сделка в оборот не входят,
 *    но расходы по ним понесены и в марже периода стоят.
 * 3. **Порог значимости считается только по лари** и потому занижен. Занижение
 *    названо на экране: цифра, которая молча меньше правды, хуже отсутствующей.
 */
export default async function OwnerSummaryPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const period = ownerPeriodOf(typeof query.period === 'string' ? query.period : undefined);
  const l = { dict: dictionaryOf(locale), locale };
  const view = await getOwnerSummary(period);
  const month = formatMonth(locale, view.bounds.monthAt);

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="owner.screen.summary" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'owner.summary.title')}</h1>
          <span className="faint">{month}</span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'owner.summary.subtitle')}</p>
      </div>

      <nav className="chips" aria-label={t(l.dict, 'owner.period.label')}>
        {OWNER_PERIODS.map((item) => (
          <a
            className="chip"
            key={item}
            href={`/${locale}/owner?period=${item}`}
            aria-current={item === period ? 'true' : undefined}
          >
            {t(l.dict, `owner.period.${item}`)}
          </a>
        ))}
      </nav>

      <div className="metrics">
        <div className="metric">
          <Eyebrow l={l} labelKey="owner.metric.deals" />
          <span className="metric__value">{formatNumber(locale, view.summary.deals)}</span>
          <span className="metric__note">{t(l.dict, 'owner.metric.deals.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="owner.metric.settled" />
          <span className="metric__value">{formatNumber(locale, view.summary.settledDeals)}</span>
          <span className="metric__note">{t(l.dict, 'owner.metric.settled.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="owner.metric.currencies" />
          <span className="metric__value">
            {formatNumber(locale, view.summary.byCurrency.length)}
          </span>
          <span className="metric__note">{t(l.dict, 'owner.metric.currencies.note')}</span>
        </div>
      </div>

      {view.summary.byCurrency.length === 0 ? (
        <EmptyState l={l} titleKey="owner.summary.empty.title" bodyKey="owner.summary.empty.body" />
      ) : (
        view.summary.byCurrency.map((slice) => (
          <section className="card" key={slice.currency} aria-labelledby={`sum-${slice.currency}`}>
            <h2 className="card__title" id={`sum-${slice.currency}`}>
              {t(l.dict, 'owner.summary.currency.title', { currency: slice.currency })}
            </h2>
            <div className="rows">
              <Row labelKey="owner.row.turnover" l={l}>
                <Amount l={l} value={slice.turnover} size="lead" />
              </Row>
              <Row labelKey="owner.row.revenue.service" l={l}>
                <Amount l={l} value={slice.revenueByLeg.service} />
              </Row>
              <Row labelKey="owner.row.revenue.conversion" l={l}>
                <Amount l={l} value={slice.revenueByLeg.conversion} />
              </Row>
              <Row labelKey="owner.row.cost" l={l}>
                <Amount l={l} value={slice.cost} />
              </Row>
              <Row labelKey="owner.row.margin" l={l} total>
                <>
                  <Badge tone={moneyTone(slice.margin)} label={t(l.dict, 'owner.margin.fact')} />{' '}
                  <Amount l={l} value={slice.margin} size="lead" signed />
                </>
              </Row>
              {/* Форму подписи выбирает локаль, а не код: «по 1 завершённой»,
                  «по 2 завершённым», «по 5 завершённым» — три разные формы в
                  русском и одна в грузинском. */}
              <Row labelKey="owner.row.averageDeal" l={l} labelCount={slice.settledDeals}>
                {slice.averageDeal === null ? (
                  <span className="muted">{t(l.dict, 'owner.averageDeal.none')}</span>
                ) : (
                  <Amount l={l} value={slice.averageDeal} />
                )}
              </Row>
            </div>
            <p className="faint">{t(l.dict, 'owner.summary.currency.note')}</p>
          </section>
        ))
      )}

      <section className="card" aria-labelledby="significance">
        <h2 className="card__title" id="significance">
          {t(l.dict, 'owner.significance.title')}
        </h2>
        {view.significance.warn ? (
          <Banner
            tone="warn"
            titleKey="owner.significance.warn.title"
            bodyKey="owner.significance.warn.body"
            l={l}
            params={{ value: formatBasisPoints(locale, view.significance.shareBp) }}
          />
        ) : null}
        <div className="rows">
          <Row labelKey="owner.significance.monthly" l={l}>
            <Amount l={l} value={view.significance.monthly} size="lead" />
          </Row>
          <Row labelKey="owner.significance.threshold" l={l}>
            <Amount l={l} value={view.significance.threshold} />
          </Row>
          <Row labelKey="owner.significance.headroom" l={l} total>
            <Amount l={l} value={view.significance.headroom} />
          </Row>
          <Row labelKey="owner.significance.share" l={l}>
            <span className="mono">{formatBasisPoints(locale, view.significance.shareBp)}</span>
          </Row>
        </div>
        <p className="muted">{t(l.dict, 'owner.significance.note')}</p>
        <p className="faint">{t(l.dict, 'owner.significance.gelOnly')}</p>
      </section>

      <section className="card card--quiet" aria-labelledby="owner-limits">
        <h2 className="card__title" id="owner-limits">
          {t(l.dict, 'owner.limits.title')}
        </h2>
        <p className="muted">{t(l.dict, 'owner.limits.body')}</p>
        <p className="faint">
          {plural(l.dict, locale, 'owner.limits.count', ROLE_CAPABILITIES.owner.length)}
        </p>
      </section>
    </>
  );
}
