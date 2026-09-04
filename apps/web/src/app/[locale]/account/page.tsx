import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatDateTime } from '@/i18n/format';
import { getAccount, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Amount, BlockedAction, EmptyState, Eyebrow, ListRow, Row, SecurityBlock, StatusDot } from '@/ui/primitives';

/**
 * Экран 4 — мой счёт.
 *
 * Здесь живёт обещание «деньги остаются вашими»: свободная часть и запертая
 * показаны раздельно, и по каждой запертой сумме видно, **под какой сделкой и
 * до какого момента** (`FUNCTIONAL.md` §2.1).
 *
 * Остатки в разных валютах **не суммируются**: каждая валюта — отдельный счёт
 * номинального держания и отдельная сверка, единой суммы «всего у вас» не
 * существует, и показывать её было бы вымыслом (`IMPLEMENTATION.md` §3).
 */
export default async function AccountPage({
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
  const account = await getAccount();
  const viewerZone = viewerTimeZone();
  const currentTime = now();

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'account.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'account.subtitle')}</p>
      </div>

      <section className="card" aria-labelledby="by-currency">
        <h2 className="card__title" id="by-currency">
          {t(l.dict, 'account.byCurrency.title')}
        </h2>
        <div className="list">
          {account.balances.map((balance) => (
            <ListRow
              key={balance.currency}
              label={<span className="mono">{balance.currency}</span>}
              value={
                <>
                  <Amount l={l} value={balance.free} size="lead" labelKey="account.free.title" />
                  {/* Запертая часть показывается только там, где она есть:
                      нулевая строка «заперто 0» читается как «что-то заперли». */}
                  {balance.locked.minor > 0n ? (
                    <Amount l={l} value={balance.locked} size="muted" labelKey="account.locked.title" />
                  ) : null}
                </>
              }
            />
          ))}
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'account.byCurrency.note')}
        </p>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'account.free.note')}
        </p>

        <div style={{ marginBlockStart: 'var(--s-4)' }}>
          {account.withdrawState === 'W-03' ? (
            <BlockedAction l={l} labelKey="account.withdraw.cta" reasonKey="account.withdraw.locked.reason" />
          ) : account.withdrawState === 'W-04' ? (
            <BlockedAction l={l} labelKey="account.withdraw.cta" reasonKey="account.withdraw.noSource" />
          ) : (
            <>
              <p className="actions">
                <a className="btn" href={`/${locale}/withdraw`}>
                  {t(l.dict, 'account.withdraw.cta')}
                </a>
                <a className="btn btn--secondary" href={`/${locale}/archive`}>
                  {t(l.dict, 'archive.title')}
                </a>
              </p>
              <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
                {t(l.dict, 'account.withdraw.note', {
                  account: account.sourceAccountMasked,
                  bank: account.sourceBank,
                })}
              </p>
            </>
          )}
          {account.withdrawState === 'W-02' ? (
            <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
              {t(l.dict, 'account.withdraw.partial')}
            </p>
          ) : null}
        </div>
      </section>

      <section className="card" aria-labelledby="locked-part">
        <h2 className="card__title" id="locked-part">
          {t(l.dict, 'account.locked.title')}
        </h2>
        <p className="muted">{t(l.dict, 'account.locked.note')}</p>
        <div style={{ marginBlockStart: 'var(--s-3)' }}>
          {account.lockedParts.length === 0 ? (
            <p className="muted">{t(l.dict, 'account.locked.empty')}</p>
          ) : (
            <ul>
              {account.lockedParts.map((part) => (
                <li className="locked-item" key={part.dealId}>
                  <div className="row">
                    <span className="row__key">
                      <a href={`/${locale}/deals/${part.dealId}`}>{part.address}</a>
                    </span>
                    <span className="row__value">
                      <Amount l={l} value={part.amount} />
                    </span>
                  </div>
                  <span className="faint">
                    <span className="mono">{part.dealRef}</span>
                  </span>
                  <span className="faint">
                    <StatusDot tone="wait" />{' '}
                    {part.deadline === null || part.deadline.at === null
                      ? t(l.dict, 'account.locked.untilPaused')
                      : t(l.dict, 'account.locked.until', {
                          value: formatDateTime(locale, part.deadline.at, OPERATIONS_TIME_ZONE),
                        })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="history">
        <h2 className="card__title" id="history">
          {t(l.dict, 'account.history.title')}
        </h2>
        {screenState === 'empty' || account.records.length === 0 ? (
          <EmptyState l={l} titleKey="account.history.empty.title" bodyKey="account.history.empty.body" />
        ) : (
          <ul>
            {account.records.map((record) => (
              <li className="record" key={record.id}>
                <div className="record__top">
                  <span className="record__label">{t(l.dict, record.memoKey)}</span>
                  <Amount l={l} value={record.amount} signed />
                </div>
                <span className="record__meta">
                  {formatDate(locale, record.at, viewerZone)}
                  {record.dealRef === null ? null : (
                    <>
                      {' '}
                      <a href={`/${locale}/deals/${record.dealId}`}>
                        <span className="mono">{record.dealRef}</span>
                      </a>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'account.history.note')}
        </p>
      </section>

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="account.source.title" />
        <div className="rows" style={{ marginBlockStart: 'var(--s-3)' }}>
          <Row l={l} labelKey="account.source.account">
            <span className="mono">{account.sourceAccountMasked}</span>
          </Row>
          <Row l={l} labelKey="account.source.bank">
            <span>{account.sourceBank}</span>
          </Row>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'account.source.note')}
        </p>
      </section>

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
