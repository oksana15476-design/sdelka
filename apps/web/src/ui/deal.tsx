import type { ReactNode } from 'react';
import type { DealSnapshot } from '@/fixtures/store';
import { type RequiredAction, requiredAction } from '@/view/action';
import { buildTimeline } from '@/view/timeline';
import { formatDate, formatDateTime, formatMoney } from '@/i18n/format';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';
import { Amount, AmountSkeleton, Badge, BlockedAction, DeadlineTimer, Disclosure, Row, StatusDot } from './primitives';

interface DealProps {
  readonly l: L10n;
  readonly deal: DealSnapshot;
  readonly now: number;
  readonly operationsZone: string;
  readonly viewerZone: string;
}

/**
 * `C-01` «Где мои деньги» — самый верх экрана, всегда виден, не сворачивается.
 * Восемнадцать положений, у каждого свой заголовок, своё тело и своя сумма;
 * формулировки различаются по роли, состояние одно (`SCREENS.md` §2.2).
 */
export function MoneyLocation({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const base = `deal.${deal.role}.where.${deal.moneyState}`;
  const unavailable =
    deal.moneyState === 'frozen' || deal.moneyState === 'heldThirdParty' || deal.moneyState === 'unidentified';
  // Скрывается только сумма в лари: она пересчитывается. Сумма в валюте
  // перевода известна точно и прячется зря — клиент должен видеть, что его
  // деньги на месте, даже когда курс пересчитывается.
  const hidden = deal.modifiers.quoteExpired && deal.foreignBalance === null;
  return (
    <section className={`card where where--${deal.tone}`} aria-labelledby="where-money">
      <div className="where__head">
        <StatusDot tone={deal.tone} />
        <div>
          <h2 className="where__title" id="where-money">
            {t(l.dict, `${base}.title`)}
          </h2>
          <p className="where__body">{t(l.dict, `${base}.body`, { bank: t(l.dict, 'glossary.custodian') })}</p>
        </div>
      </div>
      <p className="where__amount">
        {hidden ? (
          <AmountSkeleton l={l} labelKey={`${base}.amountLabel`} />
        ) : deal.moneyState === 'onAccountFx' && deal.foreignBalance !== null ? (
          <Amount l={l} value={deal.foreignBalance} size="lead" labelKey={`${base}.amountLabel`} />
        ) : deal.moneyState === 'partiallyFunded' && deal.shortfall !== null ? (
          <>
            <Amount l={l} value={deal.credited} size="lead" labelKey={`${base}.amountLabel`} />
            <span className="faint">
              {t(l.dict, 'deal.money.shortfall', { value: formatMoney(l.locale, deal.shortfall) })}
            </span>
          </>
        ) : (
          <Amount
            l={l}
            value={deal.required}
            size="lead"
            unavailable={unavailable}
            labelKey={`${base}.amountLabel`}
          />
        )}
      </p>
      {deal.confirmationNo === null ? null : (
        <p className="faint">
          {t(l.dict, 'deal.confirmationNo')} <span className="mono">{deal.confirmationNo}</span>
        </p>
      )}
    </section>
  );
}

/** `C-02` — ровно одно требуемое действие либо явное ожидание с субъектом. */
export function PrimaryActionBlock({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const action: RequiredAction = requiredAction(deal);
  const params = {
    counterparty: deal.counterpartyName,
    amount: deal.shortfall === null ? formatMoney(l.locale, deal.required) : formatMoney(l.locale, deal.shortfall),
  };
  return (
    <section className="card" aria-labelledby="required-action">
      <h2 className="card__title" id="required-action">
        {t(l.dict, 'deal.action.heading')}
      </h2>
      <p style={{ fontWeight: 600 }}>{t(l.dict, action.titleKey, params)}</p>
      {action.kind === 'blocked' && action.ctaKey !== null && action.reasonKey !== null ? (
        <div style={{ marginBlockStart: 'var(--s-3)' }}>
          <BlockedAction l={l} labelKey={action.ctaKey} reasonKey={action.reasonKey} params={params} />
        </div>
      ) : null}
      {action.kind === 'action' && action.ctaKey !== null ? (
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn" href={`/${l.locale}/deals/${deal.id}`}>
            {t(l.dict, action.ctaKey, params)}
          </a>
        </p>
      ) : null}
      {action.kind === 'dual' && action.ctaKey !== null && action.secondaryCtaKey !== null ? (
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn btn--secondary" href={`/${l.locale}/account`}>
            {t(l.dict, action.ctaKey, params)}
          </a>
          <a className="btn btn--secondary" href={`/${l.locale}/deals/${deal.id}`}>
            {t(l.dict, action.secondaryCtaKey, params)}
          </a>
        </p>
      ) : null}
    </section>
  );
}

const ROLLBACK_STATES = ['rollbackInProgress', 'releasedToAccount', 'refundInProgress', 'refunded'];

/**
 * `C-04` — деньги: сумма сделки, что на счёте, комиссия, итог получателю.
 *
 * У несостоявшейся сделки состав строк другой: комиссии нет — её берут за
 * исполненный расчёт, а расчёта не было. Показывать её в откате значит обещать
 * удержание, которого не будет.
 */
export function MoneyCard({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const hidden = deal.modifiers.quoteExpired;
  const rollback = ROLLBACK_STATES.includes(deal.moneyState);
  if (rollback) {
    return (
      <section className="card" aria-labelledby="money-card">
        <h2 className="card__title" id="money-card">
          {t(l.dict, 'deal.money.heading')}
        </h2>
        <div className="rows">
          <Row l={l} labelKey="deal.money.dealAmount">
            <Amount l={l} value={deal.required} size="muted" />
          </Row>
          <Row l={l} labelKey="deal.money.withheld">
            <Amount l={l} value={{ currency: deal.required.currency, minor: 0n }} size="muted" />
          </Row>
          <Row l={l} labelKey="deal.money.returned" total>
            <Amount l={l} value={deal.required} />
          </Row>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'deal.money.rollbackNote')}
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="money-card">
      <h2 className="card__title" id="money-card">
        {t(l.dict, 'deal.money.heading')}
      </h2>
      <div className="rows">
        <Row l={l} labelKey="deal.money.dealAmount">
          {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.required} />}
        </Row>
        {deal.role === 'paying' ? (
          <Row l={l} labelKey="deal.money.onAccount">
            {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.credited} size="muted" />}
          </Row>
        ) : null}
        {deal.locked.minor > 0n ? (
          <Row l={l} labelKey="deal.money.reserved">
            <Amount l={l} value={deal.locked} size="muted" />
          </Row>
        ) : null}
        {deal.excess === null ? null : (
          <Row l={l} labelKey="deal.money.excess">
            <Amount l={l} value={deal.excess} size="muted" />
          </Row>
        )}
        <Row l={l} labelKey="deal.money.fee">
          {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.fee} size="muted" />}
        </Row>
        <Row l={l} labelKey="deal.money.payeeReceives" total>
          {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.payeeReceives} />}
        </Row>
      </div>
      <Disclosure l={l} summaryKey="deal.money.feeBreakdown.summary">
        <p className="muted">{t(l.dict, 'deal.money.feeBreakdown.body')}</p>
      </Disclosure>
      {hidden ? (
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'deal.money.quoteExpired')}
        </p>
      ) : null}
    </section>
  );
}

/** `C-06` — лента сделки. Человеческим языком, не техническими статусами. */
export function DealTimeline({ l, deal, viewerZone }: DealProps): ReactNode {
  const steps = buildTimeline(deal);
  return (
    <section className="card" aria-labelledby="timeline">
      <h2 className="card__title" id="timeline">
        {t(l.dict, 'deal.timeline.heading')}
      </h2>
      <ol className="timeline">
        {steps.map((step, index) => {
          const tone = step.state === 'done' ? 'ok' : step.state === 'current' ? 'action' : step.state === 'missed' ? 'warn' : step.state === 'branch' ? 'warn' : 'wait';
          return (
            <li className={`timeline__step timeline__step--${step.state}`} key={step.key}>
              <span className="timeline__mark">
                <StatusDot tone={tone} />
                {index === steps.length - 1 ? null : <span className="timeline__line" />}
              </span>
              <span>
                <span className="timeline__label">{t(l.dict, `deal.${deal.role}.timeline.${step.key}`)}</span>
                <span className="visually-hidden">{t(l.dict, `deal.timeline.state.${step.state}`)}</span>
                {step.at === null ? null : (
                  <span className="timeline__meta"> {formatDate(l.locale, step.at, viewerZone)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {deal.modifiers.clockPaused ? (
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'deal.timeline.clockPaused')}
        </p>
      ) : null}
    </section>
  );
}

/** `C-07` — объект: реестр против договора. Расхождение блокирует переход дальше. */
export function PropertyCard({ l, deal, viewerZone }: DealProps): ReactNode {
  return (
    <section className="card" aria-labelledby="property">
      <h2 className="card__title" id="property">
        {t(l.dict, 'deal.property.heading')}
      </h2>
      <div className="rows">
        <Row l={l} labelKey="deal.property.address">
          <span>{deal.property.address}</span>
        </Row>
        <Row l={l} labelKey="deal.property.addressLatin">
          <span>{deal.property.addressLatin}</span>
        </Row>
        <Row l={l} labelKey="deal.property.cadastral">
          <span className="mono">{deal.property.cadastral}</span>
        </Row>
        <Row l={l} labelKey="deal.property.owner">
          <span>{deal.property.ownerRegistry}</span>
        </Row>
        <Row l={l} labelKey="deal.property.extract">
          <span>{formatDate(l.locale, deal.property.extractAt, viewerZone)}</span>
        </Row>
      </div>
      {deal.property.hasMismatch ? (
        <div style={{ marginBlockStart: 'var(--s-4)' }}>
          <table className="compare">
            <caption className="compare__mismatch">{t(l.dict, 'deal.property.mismatch.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(l.dict, 'deal.property.mismatch.field')}</th>
                <th scope="col">{t(l.dict, 'deal.property.mismatch.contract')}</th>
                <th scope="col">{t(l.dict, 'deal.property.mismatch.registry')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t(l.dict, 'deal.property.area')}</th>
                <td>{deal.property.areaContract}</td>
                <td className="compare__mismatch">{deal.property.areaRegistry}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'deal.property.mismatch.whatNow')}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** `C-10` — стороны с уровнем проверки и документы. Персональных данных нет. */
export function PartiesAndDocs({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const counterpartyRoleKey = deal.role === 'paying' ? 'deal.parties.role.recipient' : 'deal.parties.role.payer';
  return (
    <section className="card" aria-labelledby="parties">
      <h2 className="card__title" id="parties">
        {t(l.dict, 'deal.parties.heading')}
      </h2>
      <div className="rows">
        <Row l={l} labelKey="deal.parties.you">
          <Badge tone="ok" label={t(l.dict, 'deal.parties.verified')} />
        </Row>
        <Row l={l} labelKey={counterpartyRoleKey}>
          <span>{deal.counterpartyName}</span>
        </Row>
      </div>
      <hr className="rule" />
      <div className="rows">
        <Row l={l} labelKey="deal.docs.contract">
          <a href={`/${l.locale}/deals/${deal.id}`}>{t(l.dict, 'deal.docs.open')}</a>
        </Row>
        {deal.applicationId === null ? null : (
          <Row l={l} labelKey="deal.docs.application">
            <span className="mono">{deal.applicationId}</span>
          </Row>
        )}
      </div>
      <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'deal.docs.watermarkNotice')}
      </p>
    </section>
  );
}

/** `C-08` — лестница подтверждения `A0…A4`. Уровень не называется гарантией. */
export function AssuranceLadder({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const levels = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;
  const currentIndex = levels.indexOf(deal.assurance);
  return (
    <section className="card" aria-labelledby="ladder">
      <h2 className="card__title" id="ladder">
        {t(l.dict, 'assurance.ladder.heading')}
      </h2>
      <ol className="ladder">
        {levels.map((level, index) => (
          <li
            className={`ladder__step${index < currentIndex ? ' ladder__step--done' : ''}${index === currentIndex ? ' ladder__step--current' : ''}`}
            key={level}
            aria-current={index === currentIndex ? 'step' : undefined}
          >
            <span className="ladder__code">{level}</span>
            {t(l.dict, `assurance.level.${level}`)}
          </li>
        ))}
      </ol>
      <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, 'assurance.ladder.note', { level: String(currentIndex), total: String(levels.length - 1) })}
      </p>
    </section>
  );
}

/** `C-38` — счёт выплаты: маска, имя владельца, статус проверки. */
export function MaskedAccount({
  l,
  iban,
  holder,
  verified,
}: {
  readonly l: L10n;
  readonly iban: string;
  readonly holder: string;
  readonly verified: boolean;
}): ReactNode {
  return (
    <span>
      <span className="mono">{iban}</span>{' '}
      <span>{holder}</span>{' '}
      <Badge
        tone={verified ? 'ok' : 'warn'}
        label={t(l.dict, verified ? 'requisites.verified' : 'requisites.unverified')}
      />
    </span>
  );
}

/**
 * `C-37` — карточка подтверждения средств. Центральный элемент вида получателя.
 *
 * ⚠ Здесь исправлена формулировка `CABINETS.md` §4.1. Документ предлагает
 * сказать получателю «деньги не у покупателя», но по решению №5 и Ф6 средства
 * до расчёта остаются собственностью вносящей стороны и **отзывны**
 * (`ROADMAP.md` И5.2). Карточка обязана назвать эту границу прямо: иначе самый
 * честный экран продукта оказывается единственным, где мы вводим в заблуждение.
 */
export function FundsAssuranceCard({ l, deal, now, operationsZone, viewerZone }: DealProps): ReactNode {
  const reserved = deal.moneyState === 'reserved' || deal.moneyState === 'submitted';
  const tone = deal.moneyState === 'released' ? 'ok' : reserved ? 'ok' : 'wait';
  const variant =
    deal.moneyState === 'released' || reserved ? '' : deal.moneyState === 'frozen' ? ' assurance--stopped' : ' assurance--pending';
  const base = `assurance.state.${deal.moneyState}`;
  return (
    <section className={`assurance${variant}`} aria-labelledby="assurance">
      <div className="where__head">
        <StatusDot tone={tone} />
        <div>
          <h1 id="assurance">{t(l.dict, `${base}.title`)}</h1>
          <p className="muted">{t(l.dict, `${base}.subtitle`)}</p>
        </div>
      </div>

      <div className="assurance__hero">
        <Amount l={l} value={deal.required} size="hero" labelKey="assurance.amountLabel" />
        {deal.reservedAt === null ? null : (
          <span className="faint">
            {t(l.dict, 'assurance.reservedAt', {
              value: formatDateTime(l.locale, deal.reservedAt, operationsZone),
            })}
          </span>
        )}
        {deal.confirmationNo === null ? null : (
          <span className="faint">
            {t(l.dict, 'deal.confirmationNo')} <span className="mono">{deal.confirmationNo}</span>
          </span>
        )}
      </div>

      <hr className="rule" />
      <h2>{t(l.dict, 'assurance.whereMoney.title')}</h2>
      <p className="muted">{t(l.dict, 'assurance.whereMoney.body', { bank: t(l.dict, 'glossary.custodian') })}</p>
      <p className="muted">{t(l.dict, 'assurance.whereMoney.revocable')}</p>

      <hr className="rule" />
      <h2>{t(l.dict, 'assurance.outcomes.title')}</h2>
      <ul className="outcomes">
        <li className="outcome">
          <span className="outcome__title">{t(l.dict, 'assurance.outcomes.registered.title')}</span>
          <span className="outcome__body">{t(l.dict, 'assurance.outcomes.registered.body')}</span>
          <Amount l={l} value={deal.payeeReceives} size="lead" labelKey="assurance.outcomes.registered.amountLabel" />
        </li>
        <li className="outcome">
          <span className="outcome__title">{t(l.dict, 'assurance.outcomes.notRegistered.title')}</span>
          <span className="outcome__body">{t(l.dict, 'assurance.outcomes.notRegistered.body')}</span>
          {/* Сумма названа и здесь: карточка, где крупная цифра стоит только у
              хорошего исхода, читается как реклама, а не как описание. */}
          <Amount l={l} value={deal.required} size="lead" labelKey="assurance.outcomes.notRegistered.amountLabel" />
          <span className="outcome__body">{t(l.dict, 'assurance.outcomes.notRegistered.retry')}</span>
        </li>
      </ul>

      <hr className="rule" />
      <h2>{t(l.dict, 'assurance.youReceive.title')}</h2>
      <div className="rows">
        <Row l={l} labelKey="deal.money.dealAmount">
          <Amount l={l} value={deal.required} />
        </Row>
        <Row l={l} labelKey="deal.money.fee">
          <Amount l={l} value={deal.fee} size="muted" />
        </Row>
        <Row l={l} labelKey="assurance.youReceive.total" total>
          <Amount l={l} value={deal.payeeReceives} />
        </Row>
      </div>

      {deal.deadline === null ? null : (
        <>
          <hr className="rule" />
          <DeadlineTimer
            l={l}
            deadline={deal.deadline}
            now={now}
            operationsZone={operationsZone}
            viewerZone={viewerZone}
          />
        </>
      )}

      <hr className="rule" />
      <p className="muted">{t(l.dict, 'assurance.limits')}</p>
      <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
        <a className="btn btn--secondary" href={`/${l.locale}/deals/${deal.id}`}>
          {t(l.dict, 'assurance.download')}
        </a>
        <a className="btn btn--ghost" href={`/${l.locale}/security`}>
          {t(l.dict, 'assurance.verify')}
        </a>
      </p>
    </section>
  );
}
