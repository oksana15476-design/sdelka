import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatNumber } from '@/i18n/format';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { getOwnerDeal } from '@/fixtures/owner';
import { VAT_REGIME_OF, moneyTone } from '@/view/owner-economics';
import { Amount, Badge, Banner, Eyebrow, Row } from '@/ui/primitives';

/**
 * Экономика одной сделки — И16.1.
 *
 * Порядок блоков задан не вкусом, а вопросами, на которые владелец приходит
 * отвечать:
 *
 * 1. **Сколько заработали и на чём** — выручка двумя ногами, потому что ноги
 *    ведут себя по-разному и живут по разным правилам возврата (§4.4).
 * 2. **Дошли ли деньги** — начислено, удержано, получено. Три разных числа, и
 *    комиссия, удержанная из платежа, но не переведённая на операционный счёт,
 *    обязана быть видна как непереведённая (`CORE.md` Ф16).
 * 3. **Что мы отдали контрагенту обмена** — себестоимость конвертации отдельно
 *    от наценки: наценка ставится **сверх** стоимости, а не является всем
 *    спредом. Слитая величина — то самое место, где валютная нога выглядела
 *    прибыльной при витринном исполнении.
 * 4. **Во что сделка обошлась** — прямые расходы построчно.
 * 5. **Что осталось** — маржа, со знаком.
 *
 * НДС здесь режимом, а не суммой: см. `owner-economics.ts`.
 */
export default async function OwnerDealPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string; readonly dealId: string }>;
}): Promise<ReactNode> {
  const { locale, dealId } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const deal = await getOwnerDeal(dealId);
  if (deal === null) notFound();

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="owner.screen.deal" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'owner.deal.title', { ref: deal.ref })}</h1>
          <Badge
            tone={deal.settled ? 'ok' : 'wait'}
            label={t(l.dict, `owner.deal.kind.${deal.kind}`)}
          />
        </div>
        <p className="pagehead__note">{deal.address}</p>
        <p className="faint">{deal.counterpartyName}</p>
      </div>

      {deal.settled ? null : (
        <Banner
          tone="info"
          titleKey="owner.deal.expected.title"
          bodyKey="owner.deal.expected.body"
          l={l}
        />
      )}

      <section className="card" aria-labelledby="deal-head">
        <h2 className="card__title" id="deal-head">
          {t(l.dict, 'owner.deal.head.title')}
        </h2>
        <div className="rows">
          <Row labelKey="owner.row.amount" l={l}>
            <Amount l={l} value={deal.amount} size="lead" />
          </Row>
          <Row labelKey="owner.row.tariffVersion" l={l}>
            {deal.tariffVersionId === null ? (
              <span className="muted">{t(l.dict, 'owner.row.tariffVersion.none')}</span>
            ) : (
              <span className="mono">{deal.tariffVersionId}</span>
            )}
          </Row>
          <Row labelKey="owner.row.settledAt" l={l}>
            {deal.settledAt === null ? (
              <span className="muted">{t(l.dict, 'owner.row.settledAt.none')}</span>
            ) : (
              <span className="mono">
                {formatDate(locale, deal.settledAt, OPERATIONS_TIME_ZONE)}
              </span>
            )}
          </Row>
          {deal.expectedFee === null ? null : (
            <Row labelKey="owner.row.expectedFee" l={l}>
              <Amount l={l} value={deal.expectedFee} unavailable />
            </Row>
          )}
        </div>
        <p className="faint">{t(l.dict, 'owner.deal.head.note')}</p>
      </section>

      {deal.economics.byCurrency.map((slice) => (
        <section className="card" key={slice.currency} aria-labelledby={`eco-${slice.currency}`}>
          <h2 className="card__title" id={`eco-${slice.currency}`}>
            {t(l.dict, 'owner.deal.economics.title', { currency: slice.currency })}
          </h2>

          <Eyebrow l={l} labelKey="owner.block.revenue" />
          <div className="rows">
            {slice.revenue.length === 0 ? (
              <Row labelKey="owner.row.revenue.none" l={l}>
                <span className="muted">{t(l.dict, 'owner.row.revenue.none.value')}</span>
              </Row>
            ) : (
              slice.revenue.map((line) => (
                <Row key={line.kind} labelKey={`owner.revenue.${line.kind}`} l={l}>
                  <>
                    <span className="faint">
                      {t(l.dict, `owner.vat.${VAT_REGIME_OF[line.kind]}`)}
                    </span>{' '}
                    <Amount l={l} value={line.amount} />
                  </>
                </Row>
              ))
            )}
            <Row labelKey="owner.row.revenue.service" l={l}>
              <Amount l={l} value={slice.revenueByLeg.service} />
            </Row>
            <Row labelKey="owner.row.revenue.conversion" l={l}>
              <Amount l={l} value={slice.revenueByLeg.conversion} />
            </Row>
          </div>
          <p className="faint">{t(l.dict, 'owner.vat.note')}</p>

          <Eyebrow l={l} labelKey="owner.block.fee" />
          <div className="rows">
            <Row labelKey="owner.fee.accrued" l={l}>
              <Amount l={l} value={slice.fee.accrued} />
            </Row>
            <Row labelKey="owner.fee.notWithheld" l={l}>
              <Amount l={l} value={slice.fee.notWithheld} />
            </Row>
            <Row labelKey="owner.fee.withheld" l={l}>
              <Amount l={l} value={slice.fee.withheld} />
            </Row>
            <Row labelKey="owner.fee.received" l={l}>
              <Amount l={l} value={slice.fee.received} />
            </Row>
            <Row labelKey="owner.fee.inTransit" l={l} total>
              <>
                <Badge
                  tone={slice.fee.inTransit.minor === 0n ? 'ok' : 'warn'}
                  label={t(
                    l.dict,
                    slice.fee.inTransit.minor === 0n ? 'owner.fee.arrived' : 'owner.fee.stuck',
                  )}
                />{' '}
                <Amount l={l} value={slice.fee.inTransit} />
              </>
            </Row>
          </div>
          <p className="faint">{t(l.dict, 'owner.fee.note')}</p>

          <Eyebrow l={l} labelKey="owner.block.conversion" />
          {slice.conversions.length === 0 ? (
            <div className="rows">
              <Row labelKey="owner.conversion.markup" l={l}>
                <Amount l={l} value={slice.revenueByLeg.conversion} />
              </Row>
              <Row labelKey="owner.conversion.absent" l={l}>
                <span className="muted">{t(l.dict, 'owner.conversion.absent.value')}</span>
              </Row>
            </div>
          ) : (
            slice.conversions.map((leg) => (
              <div className="rows" key={leg.conversionId}>
                <Row labelKey="owner.conversion.source" l={l}>
                  <Amount l={l} value={leg.source} />
                </Row>
                <Row labelKey="owner.conversion.atOfficial" l={l}>
                  <Amount l={l} value={leg.atOfficial} />
                </Row>
                <Row labelKey="owner.conversion.cost" l={l}>
                  <Amount l={l} value={leg.cost} />
                </Row>
                <Row labelKey="owner.conversion.atReference" l={l}>
                  <Amount l={l} value={leg.atReference} />
                </Row>
                <Row labelKey="owner.conversion.markup" l={l} total>
                  <Amount l={l} value={leg.markup} />
                </Row>
                <Row labelKey="owner.conversion.toClient" l={l}>
                  <Amount l={l} value={leg.toClient} />
                </Row>
              </div>
            ))
          )}
          <p className="muted">{t(l.dict, 'owner.conversion.note')}</p>

          <Eyebrow l={l} labelKey="owner.block.expenses" />
          <div className="rows">
            {slice.expenses.map((line) => (
              <Row key={line.kind} labelKey={`owner.expense.${line.kind}`} l={l}>
                <Amount l={l} value={line.amount} />
              </Row>
            ))}
            <Row labelKey="owner.row.cost" l={l} total>
              <Amount l={l} value={slice.expensesTotal} />
            </Row>
          </div>
          <p className="faint">{t(l.dict, 'owner.expense.note')}</p>

          <Eyebrow l={l} labelKey="owner.block.margin" />
          <div className="rows">
            <Row labelKey="owner.row.turnover" l={l}>
              <Amount l={l} value={slice.turnover} />
            </Row>
            <Row labelKey="owner.row.margin" l={l} total>
              <>
                <Badge
                  tone={moneyTone(slice.margin)}
                  label={t(l.dict, deal.settled ? 'owner.margin.fact' : 'owner.margin.soFar')}
                />{' '}
                <Amount l={l} value={slice.margin} size="lead" signed />
              </>
            </Row>
          </div>
        </section>
      ))}

      <section className="card card--quiet" aria-labelledby="deal-currencies">
        <h2 className="card__title" id="deal-currencies">
          {t(l.dict, 'owner.currencies.title')}
        </h2>
        <p className="muted">{t(l.dict, 'owner.currencies.body')}</p>
        <p className="faint">
          {t(l.dict, 'owner.currencies.count', {
            value: formatNumber(locale, deal.economics.byCurrency.length),
          })}
        </p>
        {/* Не ⚖-слот: слот предназначен для формулировок, прошедших юриста, и
            занимать его внутренней справкой значило бы выдать её за проверенную
            (`primitives.tsx`, `LegalSlot`). Здесь просто источник цифр. */}
        <Eyebrow l={l} labelKey="owner.legal.label" />
        <p className="muted">{t(l.dict, 'owner.legal.source')}</p>
      </section>
    </>
  );
}
