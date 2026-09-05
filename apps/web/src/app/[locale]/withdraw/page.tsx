import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { getAccount } from '@/fixtures/store';
import { getWithdraw, withdrawStatusOf } from '@/fixtures/screens';
import { Amount, Badge, BlockedAction, Eyebrow, Row, SecurityBlock } from '@/ui/primitives';

/**
 * Экран вывода средств. Машина — `packages/domain/src/client-account.ts`:
 * `requested · approved · paying_out · paid_out · blocked · cancelled`.
 *
 * Отмена доступна только в `requested`: перехода `approved → cancelled` в
 * автомате нет, поэтому кнопки быть не должно — не «серой», а никакой. Причина
 * запрета повторной заявки (`g_no_active_withdrawal`) названа словами заранее,
 * а не отказом в момент нажатия.
 */
const TONE = {
  requested: 'wait',
  approved: 'info',
  paying_out: 'info',
  paid_out: 'ok',
  blocked: 'warn',
  cancelled: 'wait',
} as const;

export default async function WithdrawPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const account = await getAccount();
  const status = withdrawStatusOf(typeof query.state === 'string' ? query.state : undefined);
  const view = await getWithdraw(status, account.free);

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}/account`}>
          {t(l.dict, 'withdraw.back')}
        </a>
      </nav>

      <div className="pagehead">
        <h1>{t(l.dict, 'withdraw.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'withdraw.subtitle')}</p>
      </div>

      <section className={`state-card state-card--${TONE[status]}`} aria-labelledby="withdraw-state">
        <div className="state-card__head">
          <div className="state-card__top">
            {/* Имени состояния машины (`paying_out`) на экране нет: клиент
                читает плашку и заголовок, а не наш автомат (§1.7 разбора). */}
            <Badge tone={TONE[status]} label={t(l.dict, `withdraw.state.${status}.badge`)} />
          </div>
          <h2 className="state-card__title" id="withdraw-state">
            {t(l.dict, `withdraw.state.${status}.title`)}
          </h2>
          <p className="state-card__body">{t(l.dict, `withdraw.state.${status}.body`)}</p>
        </div>
        <div className="state-card__inner">
          {view.cancellable ? (
            <p className="actions">
              <a className="btn btn--secondary" href={`/${locale}/withdraw?state=cancelled`}>
                {t(l.dict, 'withdraw.cancel')}
              </a>
            </p>
          ) : (
            <BlockedAction l={l} labelKey="withdraw.cancel" reasonKey="withdraw.cancel.blocked" />
          )}
          {view.repeatBlocked ? (
            <BlockedAction l={l} labelKey="withdraw.repeat" reasonKey="withdraw.repeat.blocked" />
          ) : null}
        </div>
      </section>

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="withdraw.source.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'withdraw.source.body', {
            account: view.sourceAccountMasked,
            bank: view.sourceBank,
          })}
        </p>
      </section>

      <section className="card" aria-labelledby="withdraw-amount">
        <h2 className="card__title" id="withdraw-amount">
          {t(l.dict, 'withdraw.amount.title')}
        </h2>
        <div className="rows">
          <Row l={l} labelKey="account.free.title">
            <Amount l={l} value={view.amount} />
          </Row>
          <Row l={l} labelKey="withdraw.fee">
            <Amount l={l} value={view.fee} size="muted" />
          </Row>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'withdraw.lockedNote')}
        </p>
      </section>

      {/* Переключатель состояний заявки — инструмент приёмки, в продукт не
          переносится: состояние задаётся адресом (`?state=`). */}

      <SecurityBlock l={l} />
    </>
  );
}
