import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatMoney, formatRatio, formatRemaining } from '@/i18n/format';
import { getReconciliation } from '@/fixtures/screens';
import { Amount, Badge, Eyebrow, ListRow, Row } from '@/ui/primitives';

/**
 * Экран `O-06` — сверка и покрытие.
 *
 * Покрытие клиентских средств на конец банковского дня равно единице. Это не
 * метрика, а красная линия: отклонение останавливает приём новых сделок.
 *
 * Выплата в `paying_out` без пары в выписке — единственное законное
 * «неизвестно» в системе. Повтор поручения невозможен: перехода из него обратно
 * в автомате нет, выход только через сверку, а не по таймеру.
 */
export default async function ReconciliationPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const view = await getReconciliation();
  const covered = view.obligations.minor === view.heldOnAccounts.minor;

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.reconciliation" />
        <h1>{t(l.dict, 'ops.recon.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'ops.recon.subtitle')}</p>
      </div>

      <section className={`state-card state-card--${covered ? 'ok' : 'danger'}`} aria-labelledby="coverage">
        <div className="state-card__head">
          <div className="state-card__top">
            <span className="state-card__label">{t(l.dict, 'ops.recon.coverage.title')}</span>
            <Badge
              tone={covered ? 'ok' : 'danger'}
              label={t(l.dict, covered ? 'ops.coverage.ok' : 'ops.coverage.breach')}
            />
          </div>
          <span className="amount amount--hero">
            {formatRatio(
              locale,
              view.obligations.minor === 0n
                ? 1
                : Number(view.heldOnAccounts.minor) / Number(view.obligations.minor),
            )}
          </span>
          <p className="state-card__body">{t(l.dict, 'ops.recon.coverage.note')}</p>
        </div>
        <div className="state-card__inner">
          <div className="rows">
            <Row l={l} labelKey="ops.recon.obligations">
              <Amount l={l} value={view.obligations} />
            </Row>
            <Row l={l} labelKey="ops.recon.held">
              <Amount l={l} value={view.heldOnAccounts} />
            </Row>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="breaks">
        <div className="state-card__top">
          <h2 className="card__title" id="breaks">
            {t(l.dict, 'ops.recon.breaks.title')}
          </h2>
          <span className="mono faint">
            {t(l.dict, 'ops.recon.breaks.age', {
              oldest: formatRemaining(locale, view.oldestBreakHours * 3_600_000),
              target: formatRemaining(locale, view.targetHours * 3_600_000),
            })}
          </span>
        </div>
        <div className="list">
          {view.breaks.map((item) => (
            <ListRow
              key={item.id}
              tone={item.kind === 'noPair' ? 'accent' : 'plain'}
              label={t(l.dict, `ops.recon.break.${item.kind}`)}
              meta={`${item.ref} · ${item.status} · ${formatRemaining(locale, item.ageHours * 3_600_000)}`}
              value={
                <>
                  <Amount l={l} value={item.amount} />
                  {item.difference === null ? null : (
                    <span className="list__meta">
                      {t(l.dict, 'ops.recon.difference', {
                        value: formatMoney(l.locale, item.difference),
                      })}
                    </span>
                  )}
                </>
              }
            />
          ))}
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.payout.unknown.note')}
        </p>
      </section>

      <section className="card" aria-labelledby="postings">
        <h2 className="card__title" id="postings">
          {t(l.dict, 'ops.recon.journal.title')}
        </h2>
        <div className="rows">
          {view.postings.map((posting) => (
            <Row l={l} labelKey={`ops.recon.posting.${posting.id}`} key={posting.id}>
              <Amount l={l} value={posting.amount} signed size="muted" />
            </Row>
          ))}
          <Row l={l} labelKey="ops.recon.total" total>
            <Amount l={l} value={view.total} />
          </Row>
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.recon.journal.note')}
        </p>
      </section>
    </>
  );
}
