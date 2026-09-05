import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { money } from '@sdelka/money';
import { formatMoney, formatRate, formatRemaining } from '@/i18n/format';
import { now } from '@/fixtures/store';
import { getTopup } from '@/fixtures/screens';
import { Amount, Badge, Eyebrow, ListRow, Row, SecurityBlock, StatusDot } from '@/ui/primitives';

/**
 * Экран пополнения `B-04`.
 *
 * Два независимых слоя, и оба названы идентификаторами кода, а не макета:
 * котировка (`packages/intake/src/quote.ts`) и зачисление (`matching.ts` +
 * `allocation.ts`). Когда валюта перевода совпадает с валютой сделки,
 * конвертационный слой исчезает целиком: ни строки курса, ни комиссии за
 * конвертацию, ни таймера. Курс 1:1 не показывается никогда.
 *
 * Пока курс не подтверждён, сумма в валюте сделки **скрыта**: показывать цифру
 * по курсу, которого уже нет, нельзя — клиент примет по ней решение.
 */
const TONE_BY_QUOTE = {
  firm: 'info',
  voided_by_market_move: 'warn',
  expired: 'warn',
  unavailable: 'warn',
  none: 'ok',
} as const;

const TONE_BY_INTAKE: Readonly<Record<string, 'wait' | 'info' | 'ok' | 'warn'>> = {
  awaiting: 'wait',
  exact: 'ok',
  insufficient: 'warn',
  shortfall_absorbed: 'info',
  overpayment: 'info',
  wrong_currency: 'warn',
  ambiguous: 'warn',
  unmatched: 'warn',
};

export default async function TopupPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly dealId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale, dealId } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const view = await getTopup(
    dealId,
    typeof query.quote === 'string' ? query.quote : undefined,
    typeof query.intake === 'string' ? query.intake : undefined,
  );
  if (view === null) notFound();
  const deal = view.deal;
  const conversion = deal.conversion;
  const amountsHidden = view.quote === 'expired' || view.quote === 'voided_by_market_move' || view.quote === 'unavailable';
  const intakeTone = TONE_BY_INTAKE[view.intake.id] ?? 'wait';
  // Недобор считается из требуемой и зачисленной суммы, а не берётся из
  // положения денег: экран пополнения показывает разбор поступления, и «сколько
  // не хватает» обязано быть числом, а не пустым слотом.
  const shortfall = deal.shortfall ?? money(deal.dealCurrency, deal.required.minor - deal.credited.minor);
  const excess = deal.excess ?? money(deal.dealCurrency, 0n);

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}/deals/${deal.id}`}>
          {t(l.dict, 'topup.back')}
        </a>
      </nav>

      <div className="pagehead">
        <h1>{t(l.dict, 'topup.title')}</h1>
        <p className="pagehead__note">
          <span className="mono">{deal.ref}</span> {deal.property.addressLatin}
        </p>
      </div>

      {/* Котировка. `none` — не статус, а отсутствие конвертации вовсе. */}
      <section className={`state-card state-card--${TONE_BY_QUOTE[view.quote]}`} aria-labelledby="quote">
        <div className="state-card__head">
          <div className="state-card__top">
            <Badge tone={TONE_BY_QUOTE[view.quote]} label={t(l.dict, `topup.quote.${view.quote}.badge`)} />
            {view.quote === 'firm' && view.quoteExpiresAt !== null ? (
              <span className="mono">
                {t(l.dict, 'topup.quote.timer', {
                  value: formatRemaining(locale, view.quoteExpiresAt - now()),
                })}
              </span>
            ) : null}
          </div>
          <h2 className="state-card__title" id="quote">
            {t(l.dict, `topup.quote.${view.quote}.title`)}
          </h2>
          <p className="state-card__body">{t(l.dict, `topup.quote.${view.quote}.body`)}</p>
        </div>
      </section>

      {/* Зачисление: пара «исход сопоставления × вид разнесения» из кода. */}
      <section className="card" aria-labelledby="intake">
        <div className="state-card__top">
          <h2 className="card__title" id="intake">
            {t(l.dict, `topup.intake.${view.intake.id}.title`)}
          </h2>
          <Badge tone={intakeTone} label={t(l.dict, `topup.intake.${view.intake.id}.badge`)} />
        </div>
        <p className="muted">
          {t(l.dict, `topup.intake.${view.intake.id}.body`, {
            shortfall: formatMoney(l.locale, shortfall),
            excess: formatMoney(l.locale, excess),
          })}
        </p>
        {/* Тело блока при излишке обещает «вывести его можно в любой момент».
            Обещание, названное на экране, получает на нём путь (§1.2 разбора). */}
        {view.intake.id === 'overpayment' ? (
          <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
            <a className="btn btn--secondary" href={`/${locale}/withdraw`}>
              {t(l.dict, 'deal.paying.action.withdraw.cta')}
            </a>
          </p>
        ) : null}
        {/* «Исход сопоставления» и «Вид разнесения» с экрана убраны: это поля
            маршрутизации приёма (`matching.ts`, `allocation.ts`) — наши слова о
            нашей машине, к тому же приходящие в интерфейс непереведённой
            строкой из данных (`CABINETS-REDESIGN.md` §1.7). Всё, что из них
            следует для клиента, уже сказано заголовком, плашкой и телом блока:
            зачислено или нет, сколько не хватает, что мы делаем дальше. */}
      </section>

      <section className="card" aria-labelledby="amounts">
        <h2 className="card__title" id="amounts">
          {t(l.dict, 'topup.amounts.title')}
        </h2>

        <div className="field">
          <span className="field__label">{t(l.dict, 'topup.youSend')}</span>
          <span className="fld fld--suffix">
            <span>{formatMoney(l.locale, conversion === null ? deal.required : conversion.transfer)}</span>
            <span className="fld__unit">
              {conversion === null ? deal.dealCurrency : conversion.transfer.currency}
            </span>
          </span>
        </div>

        {conversion === null ? (
          <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'topup.noConversion')}
          </p>
        ) : amountsHidden ? (
          <div className="blocked" style={{ marginBlockStart: 'var(--s-3)' }}>
            <span className="blocked__label">{t(l.dict, 'topup.hidden.label')}</span>
            <span className="blocked__reason">{t(l.dict, 'topup.hidden.body')}</span>
          </div>
        ) : (
          <>
            <div className="field">
              <span className="field__label">{t(l.dict, 'topup.weCredit')}</span>
              <span className="fld fld--suffix fld--readonly">
                <span>{formatMoney(l.locale, deal.required)}</span>
                <span className="fld__unit">{deal.dealCurrency}</span>
              </span>
            </div>
            <div className="rows" style={{ marginBlockStart: 'var(--s-3)' }}>
              <Row l={l} labelKey="deal.money.rate">
                <span className="mono">
                  {t(l.dict, 'deal.money.rate.value', {
                    from: conversion.transfer.currency,
                    value: formatRate(l.locale, conversion.rate, deal.dealCurrency),
                  })}
                </span>
              </Row>
              <Row l={l} labelKey="deal.money.marketRate">
                <span className="mono">
                  {t(l.dict, 'deal.money.rate.value', {
                    from: conversion.transfer.currency,
                    value: formatRate(l.locale, conversion.marketRate, deal.dealCurrency),
                  })}
                </span>
              </Row>
              <Row l={l} labelKey="deal.money.feeFx">
                <Amount l={l} value={conversion.fxFee} size="muted" />
              </Row>
              <Row l={l} labelKey="deal.money.fee">
                <Amount l={l} value={deal.fee} size="muted" />
              </Row>
            </div>
          </>
        )}

        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'topup.bankFees')}
        </p>
      </section>

      <section className="card" aria-labelledby="methods">
        <h2 className="card__title" id="methods">
          {t(l.dict, 'topup.methods.title')}
        </h2>
        <div className="list">
          {view.methods.map((method) => (
            <ListRow
              key={method.id}
              label={t(l.dict, `topup.method.${method.id}`)}
              meta={t(l.dict, `topup.method.${method.id}.note`)}
              value={
                <Badge
                  tone={method.status === 'available' ? 'ok' : method.status === 'checking' ? 'wait' : 'wait'}
                  label={t(l.dict, `topup.method.status.${method.status}`)}
                />
              }
              tone={method.status === 'unsuitable' ? 'quiet' : 'plain'}
            />
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="payin">
        <h2 className="card__title" id="payin">
          {t(l.dict, 'topup.requisites.title')}
        </h2>
        <div className="card card--quiet" style={{ marginBlockEnd: 'var(--s-3)' }}>
          <Eyebrow l={l} labelKey="topup.payerRule.title" />
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'topup.payerRule.body')}
          </p>
        </div>
        <div className="list">
          <ListRow
            label={t(l.dict, 'topup.requisites.beneficiary')}
            value={<span className="mono">{view.requisites.beneficiary}</span>}
          />
          <ListRow
            label={t(l.dict, 'topup.requisites.iban')}
            value={<span className="mono">{view.requisites.iban}</span>}
          />
          <ListRow
            label={t(l.dict, 'topup.requisites.swift')}
            value={<span className="mono">{view.requisites.swift}</span>}
          />
          <ListRow
            tone="accent"
            label={t(l.dict, 'topup.requisites.reference')}
            meta={t(l.dict, 'topup.requisites.reference.note')}
            value={<span className="mono">{view.requisites.reference}</span>}
          />
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          <StatusDot tone="info" /> {t(l.dict, 'topup.requisites.note')}
        </p>
      </section>

      {/* Панель прототипа с переключателями состояний в продукт не переносится:
          это инструмент приёмки. Состояния котировки и зачисления задаются
          адресом (`?quote=`, `?intake=`), а не элементом интерфейса. */}

      <SecurityBlock l={l} />
    </>
  );
}
