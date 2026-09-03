import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatDateTime, formatNumber, formatRemaining } from '@/i18n/format';
import { getOpsQueue, now } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Amount, Badge, BlockedAction, Banner, EmptyState, StatusDot } from '@/ui/primitives';

/**
 * Экран 6 — консоль операций.
 *
 * Главный экран — **не «все сделки», а «что требует меня сейчас»**: очередь
 * работы, отсортированная по сроку и сумме (`CABINETS.md` §5.1). Приоритет
 * считает система; оператор не ищет работу и не настраивает сортировку.
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
    <div className="shell--wide shell stack--loose stack">
      <div className="pagehead">
        <h1>{t(l.dict, 'ops.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'ops.subtitle')}</p>
        <p className="muted desktop-only-note">{t(l.dict, 'ops.mobileNote')}</p>
        <p className="muted desktop-only-note">{t(l.dict, 'ops.mobileStub')}</p>
      </div>

      <section className="card" aria-labelledby="coverage">
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
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
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

      <p className="faint wide-only" aria-live="polite">
        {plural(l.dict, locale, 'ops.queue.count', tasks.length)}
      </p>

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
                className={`task${overdue ? ' task--overdue' : ''}${task.type === 'approvePayout' ? '' : ' task--desktop-only'}`}
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
                      <a className="btn" href={`/${locale}/deals/${task.dealId}`}>
                        {t(l.dict, 'ops.task.action.approve')}
                      </a>
                    </p>
                    <p className="faint">{t(l.dict, 'ops.task.approve.note')}</p>
                  </>
                ) : (
                  <p className="actions">
                    <a className="btn btn--secondary" href={`/${locale}/deals/${task.dealId}`}>
                      {t(l.dict, 'ops.task.action.open')}
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="faint">
        {t(l.dict, 'common.timeZoneNote', {
          zone: OPERATIONS_TIME_ZONE,
          value: formatDateTime(locale, currentTime, OPERATIONS_TIME_ZONE),
        })}
      </p>
    </div>
  );
}
