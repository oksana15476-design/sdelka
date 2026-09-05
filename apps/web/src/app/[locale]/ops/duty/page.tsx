import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { formatNumber, formatRatio } from '@/i18n/format';
import { getOpsQueue, now } from '@/fixtures/store';
import { getReconciliation } from '@/fixtures/screens';
import { Amount, Badge, Banner, Eyebrow, Row } from '@/ui/primitives';
import { BreaksList, PostingsCard } from '@/ui/ops';
import { urgencyOf } from '@/ui/ops-work';

/**
 * Дежурный дашборд — второе и последнее место консоли, куда ходят не за
 * задачей.
 *
 * `CABINETS.md` §5.4 называет пять метрик, на которые смотрят каждое утро:
 * покрытие клиентских средств; транши в нетерминальном статусе дольше
 * норматива; выплаты в состоянии «неизвестно» дольше суток; незакрытые
 * расхождения сверки; сделки без дедлайна. Здесь они и стоят — пятью
 * значениями, а не прозой.
 *
 * Это **не раздел «сверка»**: разбор расхождения — задача, и живёт она в
 * очереди. Сюда вынесено только то, что смотрят целиком: покрытие, возраст
 * очереди расхождений и журнал проводок с видимым нулём.
 */
export default async function DutyPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const ops = await getOpsQueue();
  const view = await getReconciliation();
  const currentTime = now();

  const covered = view.obligations.minor === view.heldOnAccounts.minor;
  const breachedCurrencies = ops.coverage.filter((item) => !item.covered);
  const overdue = ops.tasks.filter((task) => urgencyOf(task.deadline, currentTime) === 'overdue');
  const unknownPayouts = ops.tasks.filter((task) => task.moneyState === 'payoutUnknown');

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.duty" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'ops.duty.title')}</h1>
          <a className="chipbtn" href={`/${locale}/ops`}>
            {t(l.dict, 'nav.queue')}
          </a>
        </div>
        <p className="pagehead__note">{t(l.dict, 'ops.duty.subtitle')}</p>
      </div>

      {breachedCurrencies.length === 0 ? null : (
        <Banner tone="critical" titleKey="ops.breach.title" bodyKey="ops.breach.body" l={l} />
      )}

      <section className={`state-card state-card--${covered ? 'ok' : 'danger'}`} aria-labelledby="coverage">
        <div className="state-card__head">
          <div className="state-card__top">
            <span className="state-card__label">{t(l.dict, 'ops.recon.coverage.title')}</span>
            <Badge
              tone={covered ? 'ok' : 'danger'}
              label={t(l.dict, covered ? 'ops.coverage.ok' : 'ops.coverage.breach')}
            />
          </div>
          <span className="amount amount--hero">
            {formatRatio(
              locale,
              view.obligations.minor === 0n
                ? 1
                : Number(view.heldOnAccounts.minor) / Number(view.obligations.minor),
            )}
          </span>
          <p className="state-card__body">{t(l.dict, 'ops.recon.coverage.note')}</p>
        </div>
        <div className="state-card__inner">
          <div className="rows">
            <Row l={l} labelKey="ops.recon.obligations">
              <Amount l={l} value={view.obligations} />
            </Row>
            <Row l={l} labelKey="ops.recon.held">
              <Amount l={l} value={view.heldOnAccounts} />
            </Row>
          </div>
        </div>
      </section>

      {/* Четыре оставшиеся метрики §5.4. Покрытие стоит выше отдельно: это
          красная линия, а не показатель в ряду. */}
      <div className="metrics">
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.duty.overdue" />
          <span className={`metric__value${overdue.length === 0 ? ' metric__value--ok' : ''}`}>
            {formatNumber(locale, overdue.length)}
          </span>
          <span className="metric__note">{t(l.dict, 'ops.duty.overdue.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.duty.unknown" />
          <span className={`metric__value${unknownPayouts.length === 0 ? ' metric__value--ok' : ''}`}>
            {formatNumber(locale, unknownPayouts.length)}
          </span>
          <span className="metric__note">{t(l.dict, 'ops.duty.unknown.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.duty.breaks" />
          <span className={`metric__value${view.breaks.length === 0 ? ' metric__value--ok' : ''}`}>
            {formatNumber(locale, view.breaks.length)}
          </span>
          <span className="metric__note">{t(l.dict, 'ops.duty.breaks.note')}</span>
        </div>
        <div className="metric">
          <Eyebrow l={l} labelKey="ops.metric.withoutDeadline" />
          <span className={`metric__value${ops.withoutDeadline === 0 ? ' metric__value--ok' : ''}`}>
            {formatNumber(locale, ops.withoutDeadline)}
          </span>
          <span className="metric__note">
            {/* Подпись согласуется с числом, которое стоит над ней в
                `.metric__value`: «1 сделок без дедлайна» — то самое место, где
                число и слово живут в разных узлах и расходятся молча. */}
            {plural(l.dict, locale, 'ops.duty.withoutDeadline.note', ops.withoutDeadline, {
              total: formatNumber(locale, ops.liveDeals),
            })}
          </span>
        </div>
      </div>

      <BreaksList
        l={l}
        items={view.breaks}
        oldestHours={view.oldestBreakHours}
        targetHours={view.targetHours}
      />

      <PostingsCard l={l} postings={view.postings} total={view.total} />

      <section className="card card--quiet" aria-labelledby="currencies">
        <h2 className="card__title" id="currencies">
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
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.coverage.note')}
        </p>
      </section>
    </>
  );
}
