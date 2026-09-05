import type { ReactNode } from 'react';
import type { CurrencyCode, Money } from '@sdelka/money';
import { money } from '@sdelka/money';
import type { DealSnapshot } from '@/fixtures/store';
import { type RequiredAction, requiredAction } from '@/view/action';
import { buildTimeline, stateDate } from '@/view/timeline';
import { formatArea, formatDate, formatDateTime, formatMoney, formatNumber, formatRate } from '@/i18n/format';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';
import {
  Amount,
  AmountSkeleton,
  Badge,
  BlockedAction,
  DeadlineTimer,
  Disclosure,
  Eyebrow,
  LegalSlot,
  legalSlotPending,
  Row,
  StatusDot,
} from './primitives';

interface DealProps {
  readonly l: L10n;
  readonly deal: DealSnapshot;
  readonly now: number;
  readonly operationsZone: string;
  readonly viewerZone: string;
}

/* ------------------------------------------------------------------------ */
/*  Поведение экрана по состоянию транша (`IMPLEMENTATION.md` §2.1).         */
/*  Признаки читаются из статуса транша, а не из положения денег: положений   */
/*  восемнадцать, а решает здесь автомат, у которого их тринадцать.           */
/* ------------------------------------------------------------------------ */

const WITH_RESERVE_PROOF = new Set(['reserved', 'release_pending', 'release_blocked', 'paying_out', 'paid_out']);
const WITH_DEADLINE = new Set(['collecting', 'collected', 'reserved', 'release_pending', 'release_blocked']);
const WITH_TOPUP = new Set(['collecting', 'collected']);
const BEFORE_COLLECTED = new Set(['pending', 'collecting']);
const REFUND_MODEL = new Set(['refund_pending', 'refunding', 'refunded']);

/**
 * Положения, где деньги на счёте свободны и обещание «забрать можно в любой
 * момент» произнесено прямым текстом (`…where.onAccount.title`,
 * `…where.overfunded.body`). Обещание без органа на экране — самый частый
 * дефект разбора (`CABINETS-REDESIGN.md` §1.2), поэтому рядом с ним стоит путь
 * к выводу, а не только слова о нём.
 */
const FREE_TO_WITHDRAW = new Set(['onAccount', 'overfunded']);

/**
 * ⚖-слот о праве отзыва. Ключи — из `DRAFT-money.md` §5, формулировка — из
 * `LEGAL-REVIEW.md` Ю-03 (одна на все точки границы, слово в слово).
 *
 * Слоты после наступления условия ревью **не прошли** (Ю-01, ⛔) и перечислены
 * в `PENDING_LEGAL_SLOTS`: пока юриста нет, на их месте не рендерится ничего —
 * ни черновик, ни наша пометка о черновике (§5.7 разбора кабинетов). У `M-13`
 * слот свой: «ответа банка нет» — не то же самое, что «выплата идёт», и одна
 * формулировка на оба положения была бы обещанием по аналогии.
 */
function revocationKey(deal: DealSnapshot): string | null {
  switch (deal.trancheStatus) {
    case 'collecting':
    case 'collected':
      return 'deal.paying.revocation.beforeReserve';
    case 'reserved':
      return deal.moneyState === 'submitted'
        ? 'deal.paying.where.submitted.revocation'
        : 'deal.paying.where.reserved.revocation';
    case 'release_pending':
    case 'paying_out':
      return deal.moneyState === 'payoutUnknown'
        ? 'deal.paying.where.payoutUnknown.revocation'
        : 'deal.paying.where.releasePending.revocation';
    default:
      return null;
  }
}

/** Ключ слота, который действительно будет показан, либо ничего. */
function visibleRevocationKey(deal: DealSnapshot): string | null {
  const key = revocationKey(deal);
  return key === null || legalSlotPending(key) ? null : key;
}

/**
 * Недобор для подстановки в текст. Берётся из положения денег, а если его там
 * нет — считается из требуемой суммы и того, что на счёте: число, зовущее
 * клиента к переводу, обязано быть числом, а не пустым слотом (та же оговорка,
 * что на экране пополнения).
 */
function shortfallOf(deal: DealSnapshot): Money<CurrencyCode> | null {
  if (deal.shortfall !== null) return deal.shortfall;
  const gap = deal.required.minor - (deal.credited.minor + deal.locked.minor);
  return gap > 0n ? money(deal.required.currency, gap) : null;
}

/**
 * Три числа расхождения — `M-07` и `M-08`.
 *
 * Разбор `CABINETS-REDESIGN.md` §1.5: кнопка на `M-07` печатала сумму сделки, а
 * не недобор, и клиент дослал бы поверх внесённого. Одного правильного числа в
 * кнопке мало: чтобы ему поверили, рядом обязаны стоять два, из которых оно
 * получено. Сумма «на счёте» считается как свободная часть плюс запертая — тем
 * же способом, каким считаются недобор и излишек (`fixtures/store.ts`), иначе
 * таблица не сходится в арифметике.
 */
function MoneyGap({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  if (deal.shortfall === null && deal.excess === null) return null;
  const onAccount = money(deal.required.currency, deal.credited.minor + deal.locked.minor);
  return (
    <div className="state-card__section">
      <div className="rows">
        <Row l={l} labelKey="deal.money.dealAmount">
          <Amount l={l} value={deal.required} size="muted" />
        </Row>
        <Row l={l} labelKey="deal.paying.where.onAccount.amountLabel">
          <Amount l={l} value={onAccount} size="muted" />
        </Row>
        {deal.shortfall === null ? null : (
          <Row l={l} labelKey="deal.money.shortfallRow" total>
            <Amount l={l} value={deal.shortfall} />
          </Row>
        )}
        {deal.excess === null ? null : (
          <Row l={l} labelKey="deal.money.excess" total>
            <Amount l={l} value={deal.excess} />
          </Row>
        )}
      </div>
    </div>
  );
}

/** Сумма, которую показывает карточка положения денег, и её метка. */
function heroAmount(deal: DealSnapshot): Money<CurrencyCode> {
  if (deal.moneyState === 'onAccountFx' && deal.conversion !== null) return deal.conversion.transfer;
  if (deal.moneyState === 'partiallyFunded') return deal.credited;
  return deal.required;
}

/**
 * `C-01` «Где мои деньги» — самый верх экрана, всегда виден, не сворачивается.
 * Одна карточка вместо трёх: положение денег, требуемое действие и срок — один
 * ответ, а не три равнозначных блока.
 *
 * Порядок внутри карточки задан приёмкой: ответ на «требуется ли что-то от
 * меня» стоит **выше** суммы по важности и читается первым в белом блоке,
 * сумма — крупной строкой над текстом, а не внутри предложения (согласование с
 * числительным ломается на «1 000 ₾ уйдут»).
 */
export function MoneyStateCard({ l, deal, now, operationsZone, viewerZone }: DealProps): ReactNode {
  const base = `deal.paying.where.${deal.moneyState}`;
  const action: RequiredAction = requiredAction(deal);
  const revocation = visibleRevocationKey(deal);
  const unavailable =
    deal.moneyState === 'frozen' || deal.moneyState === 'heldThirdParty' || deal.moneyState === 'unidentified';
  // Скрывается только сумма в валюте сделки: она пересчитывается. Сумма в
  // валюте перевода известна точно, и прятать её значит прятать деньги клиента.
  const hidden = deal.modifiers.quoteExpired && deal.conversion === null;
  // `amount` — сумма сделки и только она. Число, которое клиент отправляет,
  // приходит в свой слот (`shortfall`): подставить одно в другое здесь значит
  // позвать на перевод суммы сделки поверх уже внесённой (§1.5 разбора).
  const shortfall = shortfallOf(deal);
  const params = {
    bank: t(l.dict, 'glossary.custodian'),
    counterparty: deal.counterpartyName,
    shortfall: shortfall === null ? '' : formatMoney(l.locale, shortfall),
    excess: deal.excess === null ? '' : formatMoney(l.locale, deal.excess),
    amount: formatMoney(l.locale, deal.required),
  };
  return (
    <section className={`state-card state-card--${deal.tone}`} aria-labelledby="where-money">
      <div className="state-card__head">
        <div className="state-card__top">
          {/* Кода положения денег здесь нет и не будет: `M-07` — наше имя
              состояния, а не положение клиента. Предмет разговора с поддержкой
              уже существует и называется номером сделки (§1.7 разбора). */}
          <span className="state-card__label">
            <StatusDot tone={deal.tone} />
            {t(l.dict, 'deal.whereMoney.heading')}
          </span>
        </div>
        {hidden ? (
          <AmountSkeleton l={l} labelKey={`${base}.amountLabel`} />
        ) : (
          <Amount
            l={l}
            value={heroAmount(deal)}
            size="hero"
            unavailable={unavailable}
            labelKey={`${base}.amountLabel`}
          />
        )}
        <h2 className="state-card__title" id="where-money">
          {t(l.dict, `${base}.title`)}
        </h2>
        <p className="state-card__body">{t(l.dict, `${base}.body`, params)}</p>
      </div>

      <div className="state-card__inner">
        <div>
          <Eyebrow l={l} labelKey="deal.action.heading" />
          <p className="state-card__title" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, action.titleKey, params)}
          </p>
        </div>

        <MoneyGap l={l} deal={deal} />

        {action.kind === 'blocked' && action.ctaKey !== null && action.reasonKey !== null ? (
          <BlockedAction l={l} labelKey={action.ctaKey} reasonKey={action.reasonKey} params={params} />
        ) : null}

        {action.kind === 'action' && action.ctaKey !== null ? (
          <p className="actions">
            <a
              className="btn"
              href={WITH_TOPUP.has(deal.trancheStatus) ? `/${l.locale}/topup/${deal.id}` : `/${l.locale}/security`}
            >
              {t(l.dict, action.ctaKey, params)}
            </a>
          </p>
        ) : null}

        {action.kind === 'dual' && action.ctaKey !== null && action.secondaryCtaKey !== null ? (
          <p className="actions">
            <a className="btn btn--secondary" href={`/${l.locale}/withdraw`}>
              {t(l.dict, action.ctaKey, params)}
            </a>
            <a className="btn btn--secondary" href={`/${l.locale}/deals/new`}>
              {t(l.dict, action.secondaryCtaKey, params)}
            </a>
          </p>
        ) : null}

        {/* Обещание «забрать можно в любой момент» получает путь на том же
            экране, где произнесено. Второстепенная кнопка, а не главная:
            требуемого действия здесь нет, и подталкивать к выводу нечем. */}
        {FREE_TO_WITHDRAW.has(deal.moneyState) ? (
          <p className="actions">
            <a className="btn btn--secondary" href={`/${l.locale}/withdraw`}>
              {t(l.dict, 'deal.paying.action.withdraw.cta')}
            </a>
          </p>
        ) : null}

        {WITH_DEADLINE.has(deal.trancheStatus) && deal.deadline !== null ? (
          <div className="state-card__section">
            <DeadlineTimer
              l={l}
              deadline={deal.deadline}
              now={now}
              operationsZone={operationsZone}
              viewerZone={viewerZone}
            />
          </div>
        ) : null}

        {revocation === null ? null : (
          <div className="state-card__section">
            <LegalSlot l={l} bodyKey={revocation} labelKey="deal.paying.revocation.label" />
          </div>
        )}

        {deal.moneyState === 'frozen' && !legalSlotPending('deal.paying.where.frozen.disclosure') ? (
          <div className="state-card__section">
            <LegalSlot l={l} bodyKey="deal.paying.where.frozen.disclosure" />
          </div>
        ) : null}

        {WITH_RESERVE_PROOF.has(deal.trancheStatus) && deal.confirmationNo !== null ? (
          <div className="state-card__section">
            <span className="faint">{t(l.dict, 'deal.confirmationNo')}</span>
            <p className="actions">
              <a className="chipbtn" href={`/${l.locale}/documents`}>
                {t(l.dict, 'deal.reserveDoc')}
              </a>
              <span className="mono faint">{deal.confirmationNo}</span>
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * `C-02` — ровно одно требуемое действие либо явное ожидание с субъектом.
 *
 * У получающей стороны блок стоит **над** карточкой подтверждения средств:
 * ответ на «требуется ли что-то от меня» читается раньше суммы, иначе экран
 * отвечает на второй вопрос прежде первого (приёмка `README.md`).
 */
export function RequiredActionCard({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const action: RequiredAction = requiredAction(deal);
  const params = {
    counterparty: deal.counterpartyName,
    amount: formatMoney(l.locale, deal.required),
    shortfall: deal.shortfall === null ? '' : formatMoney(l.locale, deal.shortfall),
  };
  return (
    <section className="card" aria-labelledby="required-action">
      <Eyebrow l={l} labelKey="deal.action.heading" />
      <h2 className="state-card__title" id="required-action" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, action.titleKey, params)}
      </h2>
      {action.kind === 'blocked' && action.ctaKey !== null && action.reasonKey !== null ? (
        <div style={{ marginBlockStart: 'var(--s-3)' }}>
          <BlockedAction l={l} labelKey={action.ctaKey} reasonKey={action.reasonKey} params={params} />
        </div>
      ) : null}
      {action.kind === 'action' && action.ctaKey !== null ? (
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn" href={`/${l.locale}/requisites`}>
            {t(l.dict, action.ctaKey, params)}
          </a>
        </p>
      ) : null}
    </section>
  );
}

/**
 * `C-04` — деньги по сделке. **Три модели итога, а не одна**
 * (`IMPLEMENTATION.md` §2.1):
 *
 * · расчёт — «К получению»: сумма сделки за вычетом комиссии;
 * · возврат — «К возврату» или «Возвращено вам»: сумма сделки за вычетом
 *   невозвратной комиссии за конвертацию; комиссия за организацию расчёта **не**
 *   удерживается, потому что расчёта не было;
 * · историческая справка — «Внесено по сделке»: обязательство закрыто по
 *   истечении срока хранения, требования по сделке нет.
 *
 * Расшифровка скрыта до `collected`: считать нечего, пока деньги не собраны.
 */
export function MoneyCard({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  if (deal.trancheStatus === 'pending') return null;

  const hidden = deal.modifiers.quoteExpired;
  const refund = REFUND_MODEL.has(deal.trancheStatus);
  const historical = deal.trancheStatus === 'written_off';
  const fxFee = deal.conversion === null ? null : deal.conversion.fxFee;
  const refundTotal = money(deal.required.currency, deal.required.minor - (fxFee?.minor ?? 0n));

  const totalKey = historical
    ? 'deal.money.total.historical'
    : refund
      ? deal.trancheStatus === 'refunded'
        ? 'deal.money.total.returned'
        : 'deal.money.total.toReturn'
      : 'deal.money.total.payeeReceives';
  const totalValue = historical ? deal.required : refund ? refundTotal : deal.payeeReceives;
  const footnoteKey = historical
    ? 'deal.money.note.historical'
    : refund
      ? 'deal.money.rollbackNote'
      : 'deal.money.note.settlement';

  return (
    <section className="card" aria-labelledby="money-card">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <span className="row__key">
          <span className="amount-label">{t(l.dict, totalKey)}</span>
        </span>
        <span className="row__value">
          {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={totalValue} size="lead" />}
        </span>
      </div>
      <h2 className="visually-hidden" id="money-card">
        {t(l.dict, 'deal.money.heading')}
      </h2>

      {refund ? (
        <LegalSlot l={l} bodyKey="deal.money.rollbackNote" />
      ) : (
        <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, footnoteKey)}
        </p>
      )}

      {BEFORE_COLLECTED.has(deal.trancheStatus) ? null : (
        <Disclosure l={l} summaryKey="deal.money.breakdown.summary">
          <div className="rows">
            {deal.conversion === null ? (
              <p className="faint">{t(l.dict, 'deal.money.sameCurrency')}</p>
            ) : (
              <>
                <Row l={l} labelKey="deal.money.youSent">
                  <Amount l={l} value={deal.conversion.transfer} size="muted" />
                </Row>
                <Row l={l} labelKey="deal.money.rate">
                  <span className="mono">
                    {t(l.dict, 'deal.money.rate.value', {
                      from: deal.conversion.transfer.currency,
                      value: formatRate(l.locale, deal.conversion.rate, deal.dealCurrency),
                    })}
                  </span>
                </Row>
                <Row l={l} labelKey="deal.money.marketRate">
                  <span className="mono">
                    {t(l.dict, 'deal.money.rate.value', {
                      from: deal.conversion.transfer.currency,
                      value: formatRate(l.locale, deal.conversion.marketRate, deal.dealCurrency),
                    })}
                  </span>
                </Row>
                <Row l={l} labelKey="deal.money.feeFx">
                  <Amount l={l} value={deal.conversion.fxFee} size="muted" />
                </Row>
              </>
            )}

            <Row l={l} labelKey="deal.money.dealAmount">
              {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.required} size="muted" />}
            </Row>

            {deal.excess === null ? null : (
              <Row l={l} labelKey="deal.money.excess">
                <Amount l={l} value={deal.excess} size="muted" />
              </Row>
            )}
            {deal.shortfall === null ? null : (
              <Row l={l} labelKey="deal.money.shortfallRow">
                <Amount l={l} value={deal.shortfall} size="muted" />
              </Row>
            )}

            {refund || historical ? null : (
              <Row l={l} labelKey="deal.money.fee">
                {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={deal.fee} size="muted" />}
              </Row>
            )}

            <Row l={l} labelKey={totalKey} total>
              {hidden ? <AmountSkeleton l={l} /> : <Amount l={l} value={totalValue} />}
            </Row>
          </div>
        </Disclosure>
      )}

      {hidden ? (
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'deal.money.quoteExpired')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * `C-06` — лента сделки. Семь вех, ветка возврата и вставки; у каждого шага
 * плашка «кто держит мяч»: пока в ней не «вы», от клиента ничего не требуется.
 */
export function DealTimeline({ l, deal, viewerZone }: DealProps): ReactNode {
  const steps = buildTimeline(deal);
  // Дата в подробности — дата события состояния, а не отметка вехи: у ветки
  // возврата собственной вехи нет, а слот в тексте пустым быть не может.
  const at = stateDate(deal);
  const detailDate = at === null ? '' : formatDate(l.locale, at, viewerZone);
  return (
    <section className="card" aria-labelledby="timeline">
      <h2 className="card__title" id="timeline">
        {t(l.dict, 'deal.timeline.heading')}
      </h2>
      <p className="faint" style={{ marginBlockEnd: 'var(--s-3)' }}>
        {t(l.dict, 'deal.timeline.ballHint')}
      </p>
      <ol className="timeline">
        {steps.map((step, index) => {
          const tone =
            step.state === 'done'
              ? 'ok'
              : step.state === 'current'
                ? 'action'
                : step.state === 'missed'
                  ? 'wait'
                  : step.state === 'branch'
                    ? 'refund'
                    : 'wait';
          return (
            <li
              className={`timeline__step timeline__step--${step.state}${step.kind === 'insert' ? ' timeline__step--insert' : ''}`}
              key={`${step.kind}-${step.key}`}
            >
              <span className="timeline__mark">
                <StatusDot tone={tone} />
                {index === steps.length - 1 ? null : <span className="timeline__line" />}
              </span>
              <span>
                <span className="timeline__head">
                  <span className="timeline__label">
                    {t(
                      l.dict,
                      step.kind === 'insert'
                        ? `deal.${deal.role}.timeline.${step.key}.insert`
                        : `deal.${deal.role}.timeline.${step.key}`,
                    )}
                  </span>
                  <span className="visually-hidden">{t(l.dict, `deal.timeline.state.${step.state}`)}</span>
                  {step.ball === null ? null : (
                    <span className={`ball${step.ball === 'you' ? ' ball--you' : ''}`}>
                      {t(l.dict, `deal.ball.${step.ball}`)}
                    </span>
                  )}
                </span>
                {step.detailKey === null ? null : (
                  <span className="timeline__detail">
                    {t(l.dict, step.detailKey, {
                      date: detailDate,
                      amount: formatMoney(l.locale, deal.required),
                      collected: formatMoney(l.locale, deal.credited),
                      required: formatMoney(l.locale, deal.required),
                      shortfall: deal.shortfall === null ? '' : formatMoney(l.locale, deal.shortfall),
                      excess: deal.excess === null ? '' : formatMoney(l.locale, deal.excess),
                      confirmationNo: deal.confirmationNo ?? '',
                      applicationNo: deal.applicationId ?? '',
                      caseId: deal.ref,
                    })}
                  </span>
                )}
                {step.at === null ? null : (
                  <span className="timeline__meta">{formatDate(l.locale, step.at, viewerZone)}</span>
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

/**
 * `C-07` + `C-10` — объект и стороны под раскрытием: факты, которые читают один
 * раз, не занимают первый экран. Расхождение реестра с договором раскрывается
 * само: оно блокирует переход дальше.
 */
export function PropertyAndParties({ l, deal, viewerZone }: DealProps): ReactNode {
  const counterpartyRoleKey = deal.role === 'paying' ? 'deal.parties.role.recipient' : 'deal.parties.role.payer';
  return (
    <section className="card">
      <Disclosure l={l} summaryKey="deal.property.heading">
        <div className="split">
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
            <Row l={l} labelKey="deal.property.area">
              <span className="mono">{formatArea(l.locale, deal.property.areaRegistry)}</span>
            </Row>
            <Row l={l} labelKey="deal.property.owner">
              <span>{deal.property.ownerRegistry}</span>
            </Row>
            <Row l={l} labelKey="deal.property.extract">
              <span>{formatDate(l.locale, deal.property.extractAt, viewerZone)}</span>
            </Row>
          </div>
          <div className="rows">
            <Row l={l} labelKey="deal.parties.you">
              <Badge tone="ok" label={t(l.dict, 'deal.parties.verified')} />
            </Row>
            <Row l={l} labelKey={counterpartyRoleKey}>
              <span>{deal.counterpartyName}</span>
            </Row>
            <Row l={l} labelKey="deal.docs.contract">
              <a href={`/${l.locale}/documents`}>{t(l.dict, 'deal.docs.open')}</a>
            </Row>
            {deal.applicationId === null ? null : (
              <Row l={l} labelKey="deal.docs.application">
                <span className="mono">{deal.applicationId}</span>
              </Row>
            )}
          </div>
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'deal.property.registryNote', {
            date: formatDate(l.locale, deal.property.extractAt, viewerZone),
          })}
        </p>
        <p className="faint">{t(l.dict, 'deal.docs.watermarkNotice')}</p>
      </Disclosure>

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
                <td className="mono">{formatArea(l.locale, deal.property.areaContract)}</td>
                <td className="mono compare__mismatch">{formatArea(l.locale, deal.property.areaRegistry)}</td>
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

/**
 * `C-08` — лестница подтверждения `A0…A4`. Уровень не называется гарантией ни в
 * одном состоянии, и это сказано прямым текстом, а не подразумевается.
 */
export function AssuranceLadder({ l, deal }: { readonly l: L10n; readonly deal: DealSnapshot }): ReactNode {
  const levels = ['A0', 'A1', 'A2', 'A3', 'A4'] as const;
  const currentIndex = levels.indexOf(deal.assurance);
  return (
    <section className="card" aria-labelledby="ladder">
      <h2 className="card__title" id="ladder">
        {t(l.dict, 'assurance.ladder.heading')}
      </h2>
      <div className="ladder" role="presentation">
        {levels.slice(1).map((level, index) => (
          <span className={`ladder__bar${index < currentIndex ? ' ladder__bar--done' : ''}`} key={level} />
        ))}
      </div>
      <p className="visually-hidden">
        {t(l.dict, 'assurance.ladder.a11y', {
          level: formatNumber(l.locale, currentIndex),
          total: formatNumber(l.locale, levels.length - 1),
          name: t(l.dict, `assurance.level.${deal.assurance}`),
        })}
      </p>
      <ol className="ladder__list">
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
        {t(l.dict, `assurance.level.${deal.assurance}.hint`, { bank: t(l.dict, 'glossary.custodian') })}
      </p>
      <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'assurance.ladder.note', {
          level: formatNumber(l.locale, currentIndex),
          total: formatNumber(l.locale, levels.length - 1),
        })}
      </p>
    </section>
  );
}

/**
 * `C-37` — карточка подтверждения средств. Центральный элемент вида получателя.
 *
 * Граница обещания названа первой строкой ⚖-слота, а не смягчена преамбулой:
 * продавец, который узнает об отзывности от юриста, а не от нас, больше не
 * вернётся (`DRAFT-money.md` §5 `M-09`).
 */
export function AssuranceCard({
  l,
  deal,
  now,
  operationsZone,
  viewerZone,
  verifyUrl,
}: DealProps & { readonly verifyUrl: string }): ReactNode {
  const base = `assurance.state.${deal.moneyState}`;
  const reserved = deal.moneyState === 'reserved' || deal.moneyState === 'submitted';
  const tone = deal.moneyState === 'released' ? 'ok' : reserved ? 'ok' : deal.moneyState === 'frozen' ? 'danger' : 'wait';
  const variant = deal.moneyState === 'released' || reserved ? '' : deal.moneyState === 'frozen' ? ' assurance--stopped' : ' assurance--pending';
  const params = {
    bank: t(l.dict, 'glossary.custodian'),
    payout: formatMoney(l.locale, deal.payeeReceives),
    applicationNo: deal.applicationId ?? '',
    requisitesMasked: t(l.dict, 'assurance.youReceive.payoutVerified'),
    deadline:
      deal.deadline === null || deal.deadline.at === null
        ? ''
        : formatDateTime(l.locale, deal.deadline.at, operationsZone),
    date: deal.reservedAt === null ? '' : formatDate(l.locale, deal.reservedAt, viewerZone),
  };
  return (
    <section className={`assurance${variant}`} aria-labelledby="assurance">
      <div className="assurance__head">
        <StatusDot tone={tone} />
        <div>
          {/* Заголовок карточки — h2: единственный h1 на экране это адрес
              объекта в шапке, и второй h1 ломает оглавление скринридера. */}
          <h2 className="state-card__title" id="assurance">
            {t(l.dict, `${base}.title`)}
          </h2>
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, `${base}.subtitle`, params)}
          </p>
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
            {t(l.dict, 'assurance.confirmationNo', { value: deal.confirmationNo })}
          </span>
        )}
      </div>

      {deal.moneyState === 'releasePending' ? (
        <LegalSlot l={l} bodyKey="assurance.revocationClosed" />
      ) : null}

      <hr className="rule" />
      <h2>{t(l.dict, 'assurance.whereMoney.title')}</h2>
      <p className="muted">{t(l.dict, 'assurance.whereMoney.body', params)}</p>
      <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'assurance.whereMoney.meaning')}
      </p>
      <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'assurance.whereMoney.onRevoked')}
      </p>

      <hr className="rule" />
      <h2>{t(l.dict, 'assurance.outcomes.title')}</h2>
      <ul className="outcomes" style={{ marginBlockStart: 'var(--s-3)' }}>
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
      <div className="rows" style={{ marginBlockStart: 'var(--s-3)' }}>
        <Row l={l} labelKey="assurance.youReceive.dealAmount">
          <Amount l={l} value={deal.required} size="muted" />
        </Row>
        <Row l={l} labelKey="assurance.youReceive.fee">
          <Amount l={l} value={deal.fee} size="muted" />
        </Row>
        <Row l={l} labelKey="assurance.youReceive.total" total>
          <Amount l={l} value={deal.payeeReceives} />
        </Row>
      </div>
      <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'assurance.youReceive.note')}
      </p>

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
      <h2>{t(l.dict, 'assurance.limits.title')}</h2>
      <LegalSlot l={l} bodyKey="assurance.limits" params={{ date: formatDate(l.locale, deal.reservedAt ?? now, viewerZone), amount: formatMoney(l.locale, deal.required) }} />
      <p className="actions" style={{ marginBlockStart: 'var(--s-4)' }}>
        <a className="btn btn--secondary" href={`/${l.locale}/documents`}>
          {t(l.dict, 'assurance.download')}
        </a>
        <a className="btn btn--ghost" href={`/${l.locale}/security`}>
          {t(l.dict, 'assurance.verify')}
        </a>
      </p>
      <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'assurance.verify.note', { verifyUrl })}
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
      <span className="mono">{iban}</span> <span>{holder}</span>{' '}
      <Badge
        tone={verified ? 'ok' : 'warn'}
        label={t(l.dict, verified ? 'requisites.verified' : 'requisites.unverified')}
      />
    </span>
  );
}
