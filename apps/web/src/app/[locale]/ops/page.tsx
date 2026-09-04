import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatDateTime, formatNumber, formatPercent, formatRemaining } from '@/i18n/format';
import { getOpsQueue, now } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Amount, Badge, Banner, BlockedAction, EmptyState, Eyebrow, StatusDot } from '@/ui/primitives';

/**
 * Экран `O-01` — очередь работы.
 *
 * Консоль — **стол исключений, а не конвейер**: сделка проходит от поступления
 * денег до расчёта без человека, и сюда попадает только то, что автоматика
 * провести не смогла. Приоритет считает система; оператор не ищет работу и не
 * настраивает сортировку (`CABINETS.md` §5.1).
 *
 * Кнопки «выплатить» здесь нет и быть не может: есть «утвердить», а исполнение
 * происходит при наборе нужного числа утверждений (красная линия №5).
 */
export default async function OpsPage({
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
  const filter = typeof query.type === 'string' ? query.type : null;
  const l = { dict: dictionaryOf(locale), locale };
  const ops = await getOpsQueue();
  const currentTime = now();
  const tasks = filter === null ? ops.tasks : ops.tasks.filter((task) => task.type === filter);
  const types = [...new Set(ops.tasks.map((task) => task.type))];

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.queue" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'ops.title')}</h1>
          <span className="faint">{plural(l.dict, locale, 'ops.queue.count', tasks.length)}</span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'ops.subtitle')}</p>
        <p className="muted desktop-only-note">{t(l.dict, 'ops.mobileStub')}</p>
        <p className="muted desktop-only-note">{t(l.dict, 'ops.mobileNote')}</p>
      </div>

      <div className="metrics wide-only">
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.withoutHuman" />
          <span className="metric__value metric__value--ok">{formatPercent(locale, ops.automatedShare)}</span>
          <span className="metric__note">
            {t(l.dict, 'ops.metric.withoutHuman.note', {
              of: formatNumber(locale, ops.automatedOf),
              total: formatNumber(locale, ops.automatedTotal),
            })}
          </span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.onTable" />
          <span className="metric__value">{formatNumber(locale, ops.tasks.length)}</span>
          <span className="metric__note">{t(l.dict, 'ops.metric.onTable.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.humanRequired" />
          <span className="metric__value">{formatNumber(locale, ops.humanRequired)}</span>
          <span className="metric__note">{t(l.dict, 'ops.metric.humanRequired.note')}</span>
        </div>
      </div>

      <section className="card wide-only" aria-labelledby="coverage">
        <h2 className="card__title" id="coverage">
          {t(l.dict, 'ops.coverage.title')}
        </h2>
        <div className="coverage">
          {ops.coverage.map((item) => (
            <span key={item.currency}>
              <span className="amount-label">{item.currency}</span>
              <Badge
                tone={item.covered ? 'ok' : 'danger'}
                label={t(l.dict, item.covered ? 'ops.coverage.ok' : 'ops.coverage.breach')}
              />
            </span>
          ))}
          <span>
            <span className="amount-label">{t(l.dict, 'ops.metric.liveDeals')}</span>
            <span className="amount">{formatNumber(locale, ops.liveDeals)}</span>
          </span>
          <span>
            <span className="amount-label">{t(l.dict, 'ops.metric.withoutDeadline')}</span>
            <span className="amount">{formatNumber(locale, ops.withoutDeadline)}</span>
          </span>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.coverage.note')}
        </p>
      </section>

      {screenState === 'breach' ? (
        <Banner tone="critical" titleKey="ops.breach.title" bodyKey="ops.breach.body" l={l} />
      ) : null}

      <nav className="chips wide-only" aria-label={t(l.dict, 'ops.filter.label')}>
        <a className="chip" href={`/${locale}/ops`} aria-current={filter === null ? 'true' : undefined}>
          {t(l.dict, 'ops.filter.all')}
        </a>
        {types.map((type) => (
          <a
            className="chip"
            key={type}
            href={`/${locale}/ops?type=${type}`}
            aria-current={filter === type ? 'true' : undefined}
          >
            {t(l.dict, `ops.task.type.${type}`)}
          </a>
        ))}
      </nav>

      {screenState === 'empty' || tasks.length === 0 ? (
        <EmptyState
          l={l}
          titleKey={filter === null ? 'ops.empty.title' : 'ops.emptyFilter.title'}
          bodyKey={filter === null ? 'ops.empty.body' : 'ops.emptyFilter.body'}
          positive={filter === null}
        />
      ) : (
        <ul className="ops-grid">
          {tasks.map((task) => {
            const overdue = task.deadline?.at !== null && task.deadline !== null && task.deadline.at < currentTime;
            return (
              <li
                className={`task${overdue ? ' task--overdue' : ''}${task.claimedBy === null ? '' : ' task--claimed'}${task.type === 'approvePayout' ? '' : ' task--desktop-only'}`}
                key={task.id}
              >
                <div className="task__top">
                  <Badge tone="action" label={t(l.dict, `ops.task.type.${task.type}`)} />
                  <span className="deal-card__meta">
                    {task.deadline === null || task.deadline.at === null ? (
                      t(l.dict, 'deadline.paused.title')
                    ) : (
                      <>
                        <StatusDot tone={overdue ? 'danger' : 'wait'} />{' '}
                        {t(l.dict, 'ops.task.due', {
                          value: formatRemaining(locale, Math.abs(task.deadline.at - currentTime)),
                        })}
                      </>
                    )}
                  </span>
                </div>
                <h2 className="task__title">
                  <a href={`/${locale}/deals/${task.dealId}`}>
                    <span className="mono">{task.dealRef}</span>
                  </a>
                </h2>
                <p className="deal-card__meta">{task.address}</p>

                {/* Третий текст состояния — операторский. Одно событие, три
                    описания: у платящей стороны, у получающей и здесь. */}
                <p className="muted">
                  <span className="mono">{t(l.dict, `ops.money.${task.moneyState}.label`)}</span>
                </p>
                <p className="faint">{t(l.dict, `ops.money.${task.moneyState}.note`)}</p>

                <Amount l={l} value={task.amount} size="lead" labelKey="ops.task.amountLabel" />
                {task.deadline === null ? null : (
                  <p className="muted">{t(l.dict, `deadline.consequence.${task.deadline.kind}`)}</p>
                )}
                <p className="faint">
                  {t(l.dict, 'ops.task.age', { value: formatRemaining(locale, task.ageMs) })}
                </p>
                {task.claimedBy !== null ? (
                  <BlockedAction
                    l={l}
                    labelKey="ops.task.action.open"
                    reasonKey="ops.task.claimedBy"
                    params={{ operator: task.claimedBy }}
                  />
                ) : task.type === 'approvePayout' ? (
                  <>
                    <p className="actions">
                      <a className="btn" href={`/${locale}/ops/decision`}>
                        {t(l.dict, 'ops.task.action.open')}
                      </a>
                    </p>
                    <p className="faint">{t(l.dict, 'ops.task.approve.note')}</p>
                  </>
                ) : (
                  <p className="actions">
                    <a
                      className="btn btn--secondary"
                      href={task.type === 'reviewBreak' ? `/${locale}/ops/reconciliation` : `/${locale}/deals/${task.dealId}`}
                    >
                      {t(l.dict, 'ops.task.action.claim')}
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="card wide-only" style={{ background: 'var(--c-danger-soft)', boxShadow: 'none' }}>
        <Eyebrow l={l} labelKey="ops.cannot.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'ops.cannot.body')}
        </p>
      </section>

      <p className="faint">
        {t(l.dict, 'common.timeZoneNote', {
          zone: OPERATIONS_TIME_ZONE,
          value: formatDateTime(locale, currentTime, OPERATIONS_TIME_ZONE),
        })}
      </p>
    </>
  );
}
