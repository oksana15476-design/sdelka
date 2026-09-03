import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatDateTime } from '@/i18n/format';
import { getAccount, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Amount, BlockedAction, EmptyState, Row, SecurityBlock, StatusDot } from '@/ui/primitives';

/**
 * Экран 4 — мой счёт.
 *
 * Здесь живёт обещание «деньги остаются вашими»: свободная часть и запертая
 * показаны раздельно, и по каждой запертой сумме видно, **под какой сделкой и
 * до какого момента** (`FUNCTIONAL.md` §2.1). Кнопка вывода в состоянии
 * `W-03` не «серая», а заменена другим элементом с объяснением, почему нельзя
 * и когда снова будет можно.
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
    <div className="shell stack--loose stack">
      <div className="pagehead">
        <h1>{t(l.dict, 'account.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'account.subtitle')}</p>
      </div>

      <div className="split">
        <section className="card" aria-labelledby="free-part">
          <h2 className="card__title" id="free-part">
            {t(l.dict, 'account.free.title')}
          </h2>
          <Amount l={l} value={account.free} size="hero" />
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'account.free.note')}
          </p>
          {account.freeForeign === null ? null : (
            <p style={{ marginBlockStart: 'var(--s-3)' }}>
              <Amount l={l} value={account.freeForeign} size="lead" labelKey="account.free.foreign" />
            </p>
          )}
          <div style={{ marginBlockStart: 'var(--s-4)' }}>
            {account.withdrawState === 'W-03' ? (
              <BlockedAction l={l} labelKey="account.withdraw.locked" reasonKey="account.withdraw.locked.reason" />
            ) : account.withdrawState === 'W-04' ? (
              <BlockedAction l={l} labelKey="account.withdraw.cta" reasonKey="account.withdraw.noSource" />
            ) : (
              <>
                <p className="actions">
                  <a className="btn" href={`/${locale}/account`}>
                    {t(l.dict, 'account.withdraw.cta')}
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
          <Amount l={l} value={account.lockedTotal} size="hero" />
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'account.locked.note')}
          </p>
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
      </div>

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
      </section>

      <section className="card">
        <h2 className="card__title">{t(l.dict, 'account.source.title')}</h2>
        <div className="rows">
          <Row l={l} labelKey="account.source.account">
            <span className="mono">{account.sourceAccountMasked}</span>
          </Row>
          <Row l={l} labelKey="account.source.bank">
            <span>{account.sourceBank}</span>
          </Row>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
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
    </div>
  );
}
