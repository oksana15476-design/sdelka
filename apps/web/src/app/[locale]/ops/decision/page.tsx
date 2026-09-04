import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { getDecision } from '@/fixtures/screens';
import { Amount, Badge, BlockedAction, Eyebrow, Row, StatusDot } from '@/ui/primitives';

/**
 * Экран `O-05` — решение о выплате. Самый дорогой экран продукта.
 *
 * Три вещи, которые он обязан показать и которые нельзя урезать:
 * пакет доказательств, четыре глаза и **чего именно не хватает**. Кнопки
 * «выплатить» не существует: исполнение начинается при наборе нужного числа
 * утверждений от разных учётных записей, и утвердить своё же поручение нельзя.
 *
 * Причины недоступности названы именами guard'ов из
 * `packages/domain/src/guards.ts` — оператор ищет не «почему серо», а какое
 * условие не проходит.
 */
export default async function DecisionPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const view = await getDecision();
  if (view === null) notFound();
  const deal = view.deal;

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.decision" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'ops.decision.title')}</h1>
          <span className="mono faint">
            {deal.ref} · {deal.trancheStatus}
          </span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'ops.decision.subtitle')}</p>
      </div>

      <section className="card" style={{ background: 'var(--c-warn-soft)', boxShadow: 'none' }}>
        <Eyebrow l={l} labelKey="ops.decision.why.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'ops.decision.why.body')}
        </p>
      </section>

      <section className="card" aria-labelledby="automation">
        <h2 className="card__title" id="automation">
          {t(l.dict, 'ops.decision.automation.title')}
        </h2>
        <div className="rows">
          <Row l={l} labelKey="ops.decision.automation.matched">
            <Badge tone="ok" label={t(l.dict, 'ops.decision.done')} />
          </Row>
          <Row l={l} labelKey="ops.decision.automation.extract">
            <Badge tone="ok" label={t(l.dict, 'ops.decision.done')} />
          </Row>
          <Row l={l} labelKey="ops.decision.automation.fields">
            <Badge tone="danger" label={t(l.dict, 'ops.decision.stopped')} />
          </Row>
          <Row l={l} labelKey="ops.decision.automation.instruction">
            <Badge tone="wait" label={t(l.dict, 'ops.decision.notStarted')} />
          </Row>
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.decision.automation.note')}
        </p>
      </section>

      <section className="card" aria-labelledby="fields">
        <h2 className="card__title" id="fields">
          {t(l.dict, 'ops.decision.fields.title')}
        </h2>
        <div className="cmp">
          <div className="cmp__row cmp__row--head">
            <span className="eyebrow">{t(l.dict, 'ops.decision.fields.field')}</span>
            <span className="eyebrow">{t(l.dict, 'ops.decision.fields.contract')}</span>
            <span className="eyebrow">{t(l.dict, 'ops.decision.fields.registry')}</span>
            <span className="eyebrow">{t(l.dict, 'ops.decision.fields.verdict')}</span>
          </div>
          {view.fields.map((field) => (
            <div className={`cmp__row${field.matched ? '' : ' cmp__row--mismatch'}`} key={field.id}>
              <span>{t(l.dict, `ops.decision.field.${field.id}`)}</span>
              <span className="mono">{field.contract}</span>
              <span className="mono">{field.registry}</span>
              <span className={field.matched ? 'compare__match' : 'compare__mismatch'}>
                {t(l.dict, field.matched ? 'ops.decision.matched' : 'ops.decision.mismatched')}
              </span>
            </div>
          ))}
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.decision.fields.note')}
        </p>
      </section>

      <div className="split">
        <section className="card" aria-labelledby="evidence">
          <h2 className="card__title" id="evidence">
            {t(l.dict, 'ops.decision.evidence.title')}
          </h2>
          <div className="rows">
            {view.evidence.map((item) => (
              <Row l={l} labelKey={`ops.decision.evidence.${item.id}`} key={item.id}>
                <Badge
                  tone={item.present ? 'ok' : 'danger'}
                  label={item.note ?? t(l.dict, item.present ? 'ops.decision.present' : 'ops.decision.missing')}
                />
              </Row>
            ))}
          </div>
          <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'ops.decision.evidence.note')}
          </p>
        </section>

        <section className="card" aria-labelledby="four-eyes">
          <h2 className="card__title" id="four-eyes">
            {t(l.dict, 'ops.decision.fourEyes.title')}
          </h2>
          <div className="rows">
            <Row l={l} labelKey="ops.decision.fourEyes.approvals">
              <span className="mono">
                {view.approvalsCollected} / {view.approvalsRequired}
              </span>
            </Row>
            <Row l={l} labelKey="ops.decision.fourEyes.threshold">
              <span className="mono">{view.approvalsRequired}</span>
            </Row>
            <Row l={l} labelKey="ops.decision.fourEyes.amount">
              <Amount l={l} value={deal.required} size="muted" />
            </Row>
          </div>
          <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'ops.payout.blocked.samePreparer')}
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="missing">
        <h2 className="card__title" id="missing">
          {t(l.dict, 'ops.decision.missing.title')}
        </h2>
        <div className="security__list">
          {view.failedGuards.map((guard) => (
            <p className="security__item" key={guard}>
              <StatusDot tone="danger" />
              <span>
                {t(l.dict, `ops.guard.${guard}`)} <span className="mono">{guard}</span>
              </span>
            </p>
          ))}
          {view.passedGuards.map((guard) => (
            <p className="security__item" key={guard}>
              <StatusDot tone="ok" />
              <span>
                {t(l.dict, `ops.guard.${guard}`)} <span className="mono">{guard}</span>
              </span>
            </p>
          ))}
        </div>
        <div style={{ marginBlockStart: 'var(--s-4)' }}>
          <BlockedAction l={l} labelKey="ops.decision.send" reasonKey="ops.decision.send.blocked" />
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.task.approve.note')}
        </p>
      </section>
    </>
  );
}
