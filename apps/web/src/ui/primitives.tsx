import type { ReactNode } from 'react';
import type { CurrencyCode, Money } from '@sdelka/money';
import type { StateTone } from '@/view/money-state';
import { formatDateTime, formatMoney, formatRemaining, formatSignedMoney, formatZoneName } from '@/i18n/format';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';
import type { DeadlineView } from '@/fixtures/store';

/**
 * Индикатор состояния: цвет, форма и текст рядом. Ни одно состояние денег не
 * передаётся одним цветом (`SCREENS.md` §1.7).
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

/**
 * Сумма — единый формат везде, чтобы цифры не расходились между экранами
 * (`CABINETS.md` §6). Приходит целыми минорными единицами и форматируется
 * `Intl`; своих форматтеров нет.
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
  const text = signed ? formatSignedMoney(l.locale, value) : formatMoney(l.locale, value);
  const sizeClass =
    size === 'hero' ? ' amount--hero' : size === 'lead' ? ' amount--lead' : size === 'muted' ? ' amount--muted' : '';
  return (
    <span>
      {labelKey === undefined ? null : <span className="amount-label">{t(l.dict, labelKey)}</span>}
      <span className={`amount${sizeClass}${unavailable ? ' amount--unavailable' : ''}`}>{text}</span>
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
}: {
  readonly labelKey: string;
  readonly l: L10n;
  readonly children: ReactNode;
  readonly total?: boolean;
}): ReactNode {
  return (
    <div className={`row${total ? ' row--total' : ''}`}>
      <span className="row__key">{t(l.dict, labelKey)}</span>
      <span className="row__value">{children}</span>
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
export function SecurityBlock({ l, variant = 'footer' }: { readonly l: L10n; readonly variant?: 'footer' | 'inline' }): ReactNode {
  const items = ['security.rule.channels', 'security.rule.onlyHere', 'security.rule.neverAskTransfer'];
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
      <p className="security__item" style={{ marginBlockStart: 'var(--s-3)' }}>
        <a className="btn btn--ghost" href={`/${l.locale}/security`}>
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
      <p className="muted">{t(l.dict, 'error.moneySafe')}</p>
      <p className="faint">{t(l.dict, 'error.caseId', { id: caseId })}</p>
      <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
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
