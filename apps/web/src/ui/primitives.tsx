import type { ReactNode } from 'react';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { StateTone } from '@/view/money-state';
import {
  formatDateTime,
  formatMoney,
  formatMoneyParts,
  formatRemaining,
  formatSignedMoney,
  formatZoneName,
} from '@/i18n/format';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';
import type { DeadlineView } from '@/fixtures/store';

/**
 * Индикатор состояния: цвет, форма и текст рядом. Ни одно состояние денег не
 * передаётся одним цветом (`SCREENS.md` §1.7, брендбук §04).
 */
export function StatusDot({ tone }: { readonly tone: StateTone }): ReactNode {
  return <span className={`dot dot--${tone}`} aria-hidden="true" />;
}

export function Badge({ tone, label }: { readonly tone: StateTone; readonly label: string }): ReactNode {
  return (
    <span className={`badge badge--${tone}`}>
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

/** Надзаголовок моноширинным в разрядку: подпись блока, а не заголовок. */
export function Eyebrow({ l, labelKey }: { readonly l: L10n; readonly labelKey: string }): ReactNode {
  return <span className="eyebrow">{t(l.dict, labelKey)}</span>;
}

/**
 * Сумма — единый формат везде, чтобы цифры не расходились между экранами
 * (`CABINETS.md` §6). Приходит целыми минорными единицами и форматируется
 * `Intl`; своих форматтеров нет.
 *
 * Знак валюты рендерится отдельным узлом: знак лари ложится в слот
 * фиксированной ширины `.62em`, потому что его глифа нет ни в Manrope, ни в
 * IBM Plex Mono и без слота колонка сумм плывёт (дизайн-система §2.4).
 */
export function Amount({
  l,
  value,
  size = 'normal',
  signed = false,
  unavailable = false,
  labelKey,
}: {
  readonly l: L10n;
  readonly value: Money<CurrencyCode>;
  readonly size?: 'hero' | 'lead' | 'normal' | 'muted';
  readonly signed?: boolean;
  readonly unavailable?: boolean;
  readonly labelKey?: string;
}): ReactNode {
  const sizeClass =
    size === 'hero' ? ' amount--hero' : size === 'lead' ? ' amount--lead' : size === 'muted' ? ' amount--muted' : '';
  const parts = signed ? null : formatMoneyParts(l.locale, value);
  return (
    <span>
      {labelKey === undefined ? null : <span className="amount-label">{t(l.dict, labelKey)}</span>}
      <span className={`amount${sizeClass}${unavailable ? ' amount--unavailable' : ''}`}>
        {parts === null
          ? formatSignedMoney(l.locale, value)
          : parts.map((part, index) =>
              part.lari ? (
                <span className="lari" key={index}>
                  {part.text}
                </span>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
      </span>
    </span>
  );
}

/** Пока сумма не подтверждена — на её месте скелет, а не ноль и не «примерно». */
export function AmountSkeleton({ l, labelKey }: { readonly l: L10n; readonly labelKey?: string }): ReactNode {
  return (
    <span>
      {labelKey === undefined ? null : <span className="amount-label">{t(l.dict, labelKey)}</span>}
      <span className="skeleton" role="presentation" />
    </span>
  );
}

export function Row({
  labelKey,
  l,
  children,
  total = false,
  params,
}: {
  readonly labelKey: string;
  readonly l: L10n;
  readonly children: ReactNode;
  readonly total?: boolean;
  readonly params?: Readonly<Record<string, string | number>>;
}): ReactNode {
  return (
    <div className={`row${total ? ' row--total' : ''}`}>
      <span className="row__key">{t(l.dict, labelKey, params)}</span>
      <span className="row__value">{children}</span>
    </div>
  );
}

/**
 * ⚖-слоты, ждущие формулировки юриста. Ключ заведён здесь, строки в словарях
 * нет ни на одном языке — и до тех пор слот на клиентском экране не рендерится.
 *
 * Перечень — единственный источник правды о незакрытых слотах: он же список
 * работы для `legal-compliance-ru` и он же то, что сборка обязана перечислять
 * числом в отчёте (`CABINETS-REDESIGN.md` §5.7). Формулировки сюда не пишутся
 * ни командой, ни главредом: слот закрывается строкой в трёх словарях и
 * вычёркиванием ключа отсюда — одной правкой, которую видно в ревью.
 *
 * · `deal.paying.where.payoutUnknown.revocation` — M-13, «ответа банка нет»:
 *   что происходит с правами плательщика, пока исход выплаты неизвестен.
 * · `deal.paying.where.releasePending.revocation` — граница отзыва плательщика
 *   после наступления условия (`LEGAL-REVIEW.md` Ю-01, ⛔ на «нельзя»).
 * · `deal.paying.where.frozen.disclosure` — M-18, раскрытие о приостановке.
 * · `assurance.revocationClosed` — закрытая отзывность у получателя.
 * · `trust.weDoNot.7` — заявление о регулируемом статусе (Ю-37, ⛔).
 */
export const PENDING_LEGAL_SLOTS: readonly string[] = Object.freeze([
  'deal.paying.where.payoutUnknown.revocation',
  'deal.paying.where.releasePending.revocation',
  'deal.paying.where.frozen.disclosure',
  'assurance.revocationClosed',
  'trust.weDoNot.7',
]);

export function legalSlotPending(bodyKey: string): boolean {
  return PENDING_LEGAL_SLOTS.includes(bodyKey);
}

/**
 * ⚖-слот: строка с юридическим весом, вынесенная из тела блока отдельным
 * ключом. Отдельный ключ можно провести через юриста и заменить одной строкой,
 * не переписывая блок (`DRAFT-money.md` §3).
 *
 * Слот без формулировки юриста **не публикуется** — и не заменяется пометкой:
 * предохранитель обязан светить команде, а не клиенту
 * (`CABINETS-REDESIGN.md` §5.7). Черновик в этом месте обе стороны прочтут как
 * обещание, а внутренняя пометка на месте обещания — это наш процесс, вынесенный
 * клиенту на самый чувствительный экран кабинета. Поэтому здесь молчание:
 * ничего не утверждать безопаснее, чем утверждать непроверенное.
 *
 * Вызывающая сторона обязана спросить `legalSlotPending` **до** того, как
 * рисует обёртку слота: иначе на экране останется рамка секции без содержимого.
 */
export function LegalSlot({
  l,
  bodyKey,
  labelKey,
  params,
}: {
  readonly l: L10n;
  readonly bodyKey: string;
  readonly labelKey?: string;
  readonly params?: Readonly<Record<string, string | number>>;
}): ReactNode {
  // Второй рубеж: слот без строки в словаре молчит, а не печатает `[ключ]`.
  if (legalSlotPending(bodyKey) || l.dict[bodyKey] === undefined) return null;
  return (
    <div className="legal">
      {labelKey === undefined ? null : <span className="eyebrow">{t(l.dict, labelKey)}</span>}
      <p className="legal__body">{t(l.dict, bodyKey, params)}</p>
    </div>
  );
}

/**
 * Таймер дедлайна — `C-03`. Последствие обязательно: без него таймер не
 * рендерится вовсе. Дедлайн показывается двумя зонами (операционная и зона
 * устройства) плюс относительный остаток третьим, вспомогательным элементом:
 * относительное время никогда не единственное представление срока.
 */
export function DeadlineTimer({
  l,
  deadline,
  now,
  operationsZone,
  viewerZone,
}: {
  readonly l: L10n;
  readonly deadline: DeadlineView;
  readonly now: number;
  readonly operationsZone: string;
  readonly viewerZone: string;
}): ReactNode {
  const urgent = deadline.at !== null && deadline.at - now < 60 * 60 * 1000;
  const modifier = deadline.paused ? ' deadline--paused' : urgent ? ' deadline--urgent' : '';
  return (
    <div className={`deadline${modifier}`}>
      {deadline.at === null ? (
        <>
          <span className="deadline__primary">{t(l.dict, 'deadline.paused.title')}</span>
          <span className="deadline__secondary">
            {deadline.pauseReasonKey === null ? null : t(l.dict, deadline.pauseReasonKey)}
          </span>
          <span className="deadline__relative">
            {t(l.dict, 'deadline.paused.remaining', {
              value: formatRemaining(l.locale, deadline.remainingMs ?? 0),
            })}
          </span>
        </>
      ) : (
        <>
          <span className="deadline__primary">
            {t(l.dict, 'deadline.primary', {
              value: formatDateTime(l.locale, deadline.at, operationsZone),
              zone: formatZoneName(l.locale, deadline.at, operationsZone),
            })}
          </span>
          <span className="deadline__secondary">
            {t(l.dict, 'deadline.secondary', {
              value: formatDateTime(l.locale, deadline.at, viewerZone),
              zone: formatZoneName(l.locale, deadline.at, viewerZone),
            })}
          </span>
          <span className="deadline__relative" aria-live="polite">
            {t(l.dict, 'deadline.remaining', {
              value: formatRemaining(l.locale, Math.max(0, deadline.at - now)),
            })}
          </span>
        </>
      )}
      <p className="deadline__consequence">{t(l.dict, `deadline.consequence.${deadline.kind}`)}</p>
    </div>
  );
}

export function Banner({
  tone,
  titleKey,
  bodyKey,
  l,
  params,
}: {
  readonly tone: 'info' | 'warn' | 'critical';
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly l: L10n;
  readonly params?: Readonly<Record<string, string | number>>;
}): ReactNode {
  const dotTone: StateTone = tone === 'critical' ? 'danger' : tone === 'warn' ? 'warn' : 'info';
  return (
    <div className={`banner banner--${tone}`} role={tone === 'critical' ? 'alert' : 'status'}>
      <StatusDot tone={dotTone} />
      <div>
        <p className="banner__title">{t(l.dict, titleKey, params)}</p>
        <p className="banner__body">{t(l.dict, bodyKey, params)}</p>
      </div>
    </div>
  );
}

/**
 * Постоянный блок безопасности (`CABINETS.md` §2). Не сворачивается, не
 * скрывается, не является закрываемым окном. На экране реквизитов стоит не в
 * подвале, а непосредственно над ними.
 */
export function SecurityBlock({
  l,
  variant = 'footer',
}: {
  readonly l: L10n;
  readonly variant?: 'footer' | 'inline';
}): ReactNode {
  const items = [
    'security.rule.channels',
    'security.rule.onlyHere',
    'security.rule.neverAskTransfer',
    'security.rule.neverAskChange',
  ];
  return (
    <section className="security" data-security-block={variant} aria-labelledby={`security-${variant}`}>
      <h2 className="security__title" id={`security-${variant}`}>
        {t(l.dict, 'security.title')}
      </h2>
      <div className="security__list">
        {items.map((key) => (
          <p className="security__item" key={key}>
            <StatusDot tone="info" />
            <span>{t(l.dict, key)}</span>
          </p>
        ))}
      </div>
      <p className="actions" style={{ marginBlockStart: 'var(--s-4)' }}>
        <a className="btn btn--secondary" href={`/${l.locale}/security`}>
          {t(l.dict, 'security.report.cta')}
        </a>
      </p>
    </section>
  );
}

export function EmptyState({
  l,
  titleKey,
  bodyKey,
  positive = false,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly positive?: boolean;
}): ReactNode {
  return (
    <div className={`empty${positive ? ' empty--positive' : ''}`}>
      <h2>{t(l.dict, titleKey)}</h2>
      <p className="muted">{t(l.dict, bodyKey)}</p>
    </div>
  );
}

/**
 * Ошибка всегда отвечает на вопрос «где мои деньги»: сообщение без этого ответа
 * на экране денег не показывается ни разу (`SCREENS.md` §1.4).
 */
export function ErrorState({
  l,
  titleKey,
  caseId,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly caseId: string;
}): ReactNode {
  return (
    <div className="card" role="alert">
      <h1>{t(l.dict, titleKey)}</h1>
      <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, 'error.moneySafe')}
      </p>
      <p className="faint">{t(l.dict, 'error.caseId', { id: caseId })}</p>
      <p className="actions" style={{ marginBlockStart: 'var(--s-4)' }}>
        <a className="btn btn--secondary" href={`/${l.locale}`}>
          {t(l.dict, 'error.retry')}
        </a>
      </p>
    </div>
  );
}

/** Недоступное действие: причина рядом, а не серая кнопка без объяснения. */
export function BlockedAction({
  l,
  labelKey,
  reasonKey,
  params,
}: {
  readonly l: L10n;
  readonly labelKey: string;
  readonly reasonKey: string;
  readonly params?: Readonly<Record<string, string | number>>;
}): ReactNode {
  return (
    <div className="blocked">
      <span className="blocked__label">{t(l.dict, labelKey, params)}</span>
      <span className="blocked__reason">{t(l.dict, reasonKey, params)}</span>
    </div>
  );
}

export function Disclosure({
  l,
  summaryKey,
  children,
}: {
  readonly l: L10n;
  readonly summaryKey: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <details className="disclosure">
      <summary>{t(l.dict, summaryKey)}</summary>
      <div>{children}</div>
    </details>
  );
}

/** Строка сгруппированного списка: подпись, мета и значение справа. */
export function ListRow({
  label,
  meta,
  value,
  tone = 'plain',
}: {
  readonly label: ReactNode;
  readonly meta?: ReactNode;
  readonly value?: ReactNode;
  readonly tone?: 'plain' | 'quiet' | 'accent';
}): ReactNode {
  const modifier = tone === 'quiet' ? ' list__row--quiet' : tone === 'accent' ? ' list__row--accent' : '';
  return (
    <div className={`list__row${modifier}`}>
      <span className="list__cell">
        <span className="list__label">{label}</span>
        {meta === undefined ? null : <span className="list__meta">{meta}</span>}
      </span>
      {value === undefined ? null : <span className="list__cell list__cell--end">{value}</span>}
    </div>
  );
}

export function MoneyPlain({ l, value }: { readonly l: L10n; readonly value: Money<CurrencyCode> }): ReactNode {
  return <span className="mono">{formatMoney(l.locale, value)}</span>;
}
