import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatDateTime } from '@/i18n/format';
import { type DealSnapshot, listDeals, now, viewerName, viewerTimeZone } from '@/fixtures/store';
import { requiredAction } from '@/view/action';
import { Amount, Badge, ErrorState, Eyebrow, SecurityBlock } from '@/ui/primitives';
import { Mark } from '@/ui/chrome';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';

/**
 * Экран 1 — список сделок.
 *
 * Один список на клиента, обе роли вместе. Переключателя режимов нет: у каждой
 * строки написано, платит клиент по этой сделке или получает, и открывается она
 * тем видом, который следует из роли **в этой сделке** (`ROADMAP.md` И5.0).
 *
 * Список сгруппирован по ответу на «требуется ли что-то от меня»: сначала то,
 * что ждёт клиента, потом то, что идёт своим ходом. Плоский список заставляет
 * читать восемнадцать состояний подряд, чтобы найти одно своё.
 */
function needsViewer(deal: DealSnapshot): boolean {
  const kind = requiredAction(deal).kind;
  return kind === 'action' || kind === 'blocked' || kind === 'dual';
}

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
      <>
        <ErrorState l={l} titleKey="deals.error.title" caseId="SD-CASE-4471" />
        <SecurityBlock l={l} />
      </>
    );
  }

  if (screenState === 'empty') {
    return (
      <>
        <div className="hero-empty">
          <Mark size="lg" />
          <div className="stack--tight stack" style={{ alignItems: 'center' }}>
            <h1>{t(l.dict, 'deals.empty.title')}</h1>
            <p className="muted">{t(l.dict, 'deals.empty.body')}</p>
          </div>
          <p className="actions">
            <a className="btn" href={`/${locale}/deals/new`}>
              {t(l.dict, 'deals.empty.cta')}
            </a>
          </p>
          <div className="steps">
            {['1', '2', '3'].map((no) => (
              <div className="step" key={no}>
                <span className="step__no">{no}</span>
                <span>{t(l.dict, `deals.empty.step.${no}`)}</span>
              </div>
            ))}
            <div className="step step--accent">
              <span className="step__no">4</span>
              <span>{t(l.dict, 'deals.empty.step.4')}</span>
            </div>
          </div>
        </div>
        <SecurityBlock l={l} />
      </>
    );
  }

  const groups = [
    { id: 'action', items: deals.filter(needsViewer) },
    { id: 'running', items: deals.filter((deal) => !needsViewer(deal)) },
  ];

  return (
    <>
      <div className="pagehead">
        <div className="pagehead__row">
          <h1>{t(l.dict, 'deals.title')}</h1>
          <a className="btn" href={`/${locale}/deals/new`}>
            {t(l.dict, 'deals.add')}
          </a>
        </div>
        <p className="pagehead__note">{t(l.dict, 'deals.subtitle', { name: viewerName() })}</p>
        {screenState === 'ready' ? (
          <p className="faint">{plural(l.dict, locale, 'deals.count', deals.length)}</p>
        ) : null}
      </div>

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

      {screenState === 'ready'
        ? groups.map((group) =>
            group.items.length === 0 ? null : (
              <section className="group" key={group.id} aria-labelledby={`group-${group.id}`}>
                <div className="group__title">
                  <h2 id={`group-${group.id}`}>{t(l.dict, `deals.group.${group.id}`)}</h2>
                  <span className="faint">{t(l.dict, `deals.group.${group.id}.note`)}</span>
                </div>
                <ul className="deal-list">
                  {group.items.map((deal) => (
                    <li className="deal-card" key={deal.id}>
                      <div className="deal-card__main">
                        <div className="deal-card__top">
                          <Badge
                            tone={deal.role === 'paying' ? 'info' : 'refund'}
                            label={t(l.dict, `deals.role.${deal.role}`)}
                          />
                          <span className="deal-card__meta">{deal.ref}</span>
                        </div>
                        <h3 className="deal-card__title">
                          <a href={`/${locale}/deals/${deal.id}`}>{deal.property.addressLatin}</a>
                        </h3>
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
              </section>
            ),
          )
        : null}

      <div className="card card--quiet">
        <Eyebrow l={l} labelKey="deals.roleNote.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'deals.roleNote.body')}
        </p>
      </div>

      <p className="faint">
        {t(l.dict, 'common.timeZoneNote', {
          zone: viewerZone,
          value: formatDateTime(locale, currentTime, viewerZone),
        })}
      </p>

      <SecurityBlock l={l} />
    </>
  );
}
