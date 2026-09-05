import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatDateTime, formatNumber, formatPercent } from '@/i18n/format';
import { TASK_TYPES, getOpsQueue, now } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Banner, EmptyState, Eyebrow } from '@/ui/primitives';
import { QueueShelf, TaskRow } from '@/ui/ops';
import { groupQueue } from '@/ui/ops-work';

/**
 * Экран `O-01` — **единственный вход в работу оператора**.
 *
 * Прежде консоль была навигацией по сущностям: «решение о выплате», «сверка»,
 * «заморозка» — три раздела в панели, в каждом по одной сделке. Человек в такой
 * раскладке ищет работу сам, а очередь показывает не то, что требует его, а то,
 * что вообще есть в системе. `CABINETS.md` §5.1 требует обратного: главный
 * экран — «что требует меня сейчас», и приоритет считает система.
 *
 * Поэтому здесь одна очередь и три полки, и полки различают **разные вещи**:
 *
 * 1. `ждут вас` — решение человека, и без него не произойдёт ничего;
 * 2. `ждут внешнего факта` — реестра или банковской выписки. Человек нужен
 *    после факта, а не сейчас: из `unknown` в `submitted` перехода нет вовсе, и
 *    повтор поручения запрещён (`packages/domain/src/payout.ts:54`);
 * 3. `взято другим` — двое за одну задачу не берутся.
 *
 * Смешивать первую и вторую нельзя: задача, которую нечем закрыть, лежащая
 * среди тех, что закрыть можно, заставляет открывать её по кругу — и это ровно
 * тот способ, которым очередь перестают читать.
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
  const tasks =
    screenState === 'empty'
      ? []
      : filter === null
        ? ops.tasks
        : ops.tasks.filter((task) => task.type === filter);
  /*
   * Порядок фильтров — объявленный, а не порядок появления в очереди.
   *
   * Прежде перечень строился из отсортированного списка задач, то есть менялся
   * вместе со сроками: один и тот же фильтр каждое утро стоял в новом месте, и
   * оператор искал его глазами. Видов задач стало семнадцать, и цена такого
   * перемешивания выросла ровно в два раза. Порядок берётся из `TASK_TYPES`.
   */
  const present = new Set(ops.tasks.map((task) => task.type));
  const types = TASK_TYPES.filter((type) => present.has(type));
  const groups = groupQueue(tasks);
  const breached = screenState === 'breach' || ops.coverage.some((item) => !item.covered);

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.queue" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'ops.title')}</h1>
          {/* Счётчик заголовка описывает **всю** очередь, а не то, что видно
              на экране, и потому остаётся на телефоне: дежурному ночью важно
              знать объём смены, даже если разобрать с телефона он сможет одну
              задачу. Счётчик над полкой — наоборот, подпись к видимому списку,
              и на телефоне он скрыт (`QueueShelf`). */}
          <span className="faint">{plural(l.dict, locale, 'ops.queue.count', groups.forHuman.length)}</span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'ops.subtitle')}</p>
        <p className="muted desktop-only-note">{t(l.dict, 'ops.mobileStub')}</p>
      </div>

      {/*
       * Покрытие клиентских средств — красная линия №3, а не метрика. Нарушение
       * стоит выше очереди: пока оно не разобрано, всё остальное ждёт.
       */}
      {breached ? (
        <Banner tone="critical" titleKey="ops.breach.title" bodyKey="ops.breach.body" l={l} />
      ) : null}

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
          <Eyebrow l={l} labelKey="ops.metric.waitingHuman" />
          <span className="metric__value">{formatNumber(locale, groups.forHuman.length)}</span>
          <span className="metric__note">{t(l.dict, 'ops.metric.waitingHuman.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.waitingFact" />
          <span className="metric__value">{formatNumber(locale, groups.forFact.length)}</span>
          <span className="metric__note">{t(l.dict, 'ops.metric.waitingFact.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.coverage" />
          <span className={`metric__value${breached ? '' : ' metric__value--ok'}`}>
            {formatNumber(locale, ops.coverage.filter((item) => item.covered).length)}
            {' / '}
            {formatNumber(locale, ops.coverage.length)}
          </span>
          <span className="metric__note">{t(l.dict, 'ops.metric.coverage.note')}</span>
        </div>
      </div>

      <p className="actions wide-only">
        <a className="btn btn--secondary" href={`/${locale}/ops/duty`}>
          {t(l.dict, 'ops.duty.cta')}
        </a>
      </p>

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

      {tasks.length === 0 ? (
        <EmptyState
          l={l}
          titleKey={filter === null ? 'ops.empty.title' : 'ops.emptyFilter.title'}
          bodyKey={filter === null ? 'ops.empty.body' : 'ops.emptyFilter.body'}
          positive={filter === null}
        />
      ) : null}

      {groups.forHuman.length > 0 ? (
        <QueueShelf
          l={l}
          titleKey="ops.shelf.human.title"
          noteKey="ops.shelf.human.note"
          count={groups.forHuman.length}
        >
          {groups.forHuman.map((task) => (
            <TaskRow l={l} key={task.id} task={task} now={currentTime} />
          ))}
        </QueueShelf>
      ) : null}

      {groups.forFact.length > 0 ? (
        <QueueShelf
          l={l}
          titleKey="ops.shelf.fact.title"
          noteKey="ops.shelf.fact.note"
          count={groups.forFact.length}
          wide
        >
          {groups.forFact.map((task) => (
            <TaskRow l={l} key={task.id} task={task} now={currentTime} />
          ))}
        </QueueShelf>
      ) : null}

      {groups.claimed.length > 0 ? (
        <QueueShelf
          l={l}
          titleKey="ops.shelf.claimed.title"
          noteKey="ops.shelf.claimed.note"
          count={groups.claimed.length}
          wide
        >
          {groups.claimed.map((task) => (
            <TaskRow l={l} key={task.id} task={task} now={currentTime} />
          ))}
        </QueueShelf>
      ) : null}

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
