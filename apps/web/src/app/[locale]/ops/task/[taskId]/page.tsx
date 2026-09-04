import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatRemaining } from '@/i18n/format';
import { getOpsQueue, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { getDecision, getReconciliation, getUnfreeze, unfreezeTargetOf } from '@/fixtures/screens';
import { Amount, Badge, BlockedAction, DeadlineTimer, Eyebrow, Row } from '@/ui/primitives';
import {
  BasisCard,
  BreaksList,
  ClosingCard,
  DetailMissing,
  EvidencePackage,
  ExternalWaitCard,
  FieldsCompare,
  GuardList,
  NextCard,
  OutcomesCard,
  PostingsCard,
  WhyCard,
} from '@/ui/ops';
import { closingRuleOf, detailKindOf, externalFactOf } from '@/ui/ops-work';
import { MONEY_STATE_TONE } from '@/view/money-state';

/**
 * Карточка задачи — то, ради чего очередь вообще существует.
 *
 * Одна и та же рамка у всех восьми видов задач, и порядок блоков не меняется
 * никогда:
 *
 * 1. **почему это у вас** — иначе разбор начинается с «что тут не так»;
 * 2. **срок и последствие** — таймер без последствия не рендерится вовсе;
 * 3. **чего ждём**, если ждём не человека, — отдельным блоком, а не сноской;
 * 4. **что вы решаете** — закрытый перечень исходов, все одного веса;
 * 5. **разбор** — материалы, на которых решение строится;
 * 6. **чем решение подтверждается** — доказательство, версия политики, причины;
 * 7. **кто закрывает** — правило разделения обязанностей названо до нажатия,
 *    а не отказом в момент нажатия;
 * 8. **что произойдёт дальше**.
 *
 * Постоянство порядка важнее плотности: оператор разбирает восемь разных задач
 * за смену, и место, где написано «чем подтверждать», обязано быть одним и тем
 * же во всех восьми.
 */
export default async function OpsTaskPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly taskId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale, taskId } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const ops = await getOpsQueue();
  const task = ops.tasks.find((item) => item.id === taskId);
  if (task === undefined) notFound();

  const currentTime = now();
  const fact = externalFactOf(task.type);
  const detail = detailKindOf(task.type);
  const chosenTarget = unfreezeTargetOf(typeof query.target === 'string' ? query.target : undefined);

  const decision = detail === 'decision' ? await getDecision() : null;
  const reconciliation = detail === 'break' ? await getReconciliation() : null;
  const unfreeze = detail === 'unfreeze' ? await getUnfreeze(chosenTarget) : null;

  /* Цель разморозки выбирается ссылкой на ту же карточку: выбор — обязательное
     поле события, а не вывод системы (`packages/domain/src/freeze.ts:44`). */
  const targetHref: Readonly<Record<string, string>> | undefined =
    unfreeze === null
      ? undefined
      : Object.fromEntries(
          unfreeze.targets.map((target) => [
            `ops.unfreeze.target.${target}`,
            `/${locale}/ops/task/${taskId}?target=${target}`,
          ]),
        );

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}/ops`}>
          {t(l.dict, 'nav.queue')}
        </a>
      </nav>

      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.task" />
        <div className="pagehead__row">
          <h1>{t(l.dict, `ops.task.type.${task.type}`)}</h1>
          <span className="mono faint">{task.dealRef}</span>
        </div>
        <p className="pagehead__note">{t(l.dict, `ops.money.${task.moneyState}.note`)}</p>
      </div>

      <section className="card" aria-labelledby="subject">
        <h2 className="card__title" id="subject">
          {t(l.dict, 'ops.task.subject.title')}
        </h2>
        <div className="rows">
          <Row l={l} labelKey="ops.task.subject.deal">
            <a className="mono" href={`/${locale}/deals/${task.dealId}`}>
              {task.dealRef}
            </a>
          </Row>
          <Row l={l} labelKey="ops.task.subject.property">
            <span>{task.address}</span>
          </Row>
          <Row l={l} labelKey="ops.task.subject.money">
            <Badge
              tone={MONEY_STATE_TONE[task.moneyState]}
              label={t(l.dict, `ops.money.${task.moneyState}.label`)}
            />
          </Row>
          <Row l={l} labelKey="ops.task.amountLabel">
            <Amount l={l} value={task.amount} />
          </Row>
          <Row l={l} labelKey="ops.task.subject.age">
            <span className="mono">{formatRemaining(locale, task.ageMs)}</span>
          </Row>
        </div>
      </section>

      <WhyCard l={l} type={task.type} />

      <section className="card" aria-labelledby="deadline">
        <h2 className="card__title" id="deadline">
          {t(l.dict, 'deadline.heading')}
        </h2>
        {task.deadline === null ? (
          <p className="muted">{t(l.dict, 'deadline.none')}</p>
        ) : (
          <DeadlineTimer
            l={l}
            deadline={task.deadline}
            now={currentTime}
            operationsZone={OPERATIONS_TIME_ZONE}
            viewerZone={viewerTimeZone()}
          />
        )}
      </section>

      {fact === null ? null : <ExternalWaitCard l={l} fact={fact} />}

      <OutcomesCard
        l={l}
        type={task.type}
        chosen={unfreeze === null ? undefined : `ops.unfreeze.target.${unfreeze.chosen}`}
        hrefOf={targetHref}
      />

      {detail === 'decision' && decision !== null && decision.deal.id === task.dealId ? (
        <>
          <FieldsCompare l={l} fields={decision.fields} />
          <div className="split">
            <EvidencePackage l={l} items={decision.evidence} />
            <ClosingCard
              l={l}
              rule={closingRuleOf(task.type)}
              approvalsCollected={decision.approvalsCollected}
              approvalsRequired={decision.approvalsRequired}
              preparedBySelf={decision.preparedBySelf}
            />
          </div>
          <section className="card" aria-labelledby="missing">
            <h2 className="card__title" id="missing">
              {t(l.dict, 'ops.decision.missing.title')}
            </h2>
            <GuardList l={l} failed={decision.failedGuards} passed={decision.passedGuards} />
            <div style={{ marginBlockStart: 'var(--s-4)' }}>
              <BlockedAction l={l} labelKey="ops.decision.send" reasonKey="ops.decision.send.blocked" />
            </div>
            <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
              {t(l.dict, 'ops.task.approve.note')}
            </p>
          </section>
        </>
      ) : null}

      {detail === 'break' && reconciliation !== null ? (
        <>
          <BreaksList
            l={l}
            items={reconciliation.breaks}
            oldestHours={reconciliation.oldestBreakHours}
            targetHours={reconciliation.targetHours}
          />
          <PostingsCard l={l} postings={reconciliation.postings} total={reconciliation.total} />
        </>
      ) : null}

      {detail === 'unfreeze' && unfreeze !== null ? (
        <section className="card" aria-labelledby="case">
          <h2 className="card__title" id="case">
            {t(l.dict, 'ops.unfreeze.decision.title')}
          </h2>
          <div className="rows">
            <Row l={l} labelKey="ops.unfreeze.decision.target">
              <span className="mono">{unfreeze.chosen}</span>
            </Row>
            <Row l={l} labelKey="ops.unfreeze.decision.case">
              <span className="mono">{unfreeze.caseId}</span>
            </Row>
            <Row l={l} labelKey="ops.decision.fourEyes.approvals">
              <span className="mono">
                {unfreeze.approvalsCollected} / {unfreeze.approvalsRequired}
              </span>
            </Row>
          </div>
          <div style={{ marginBlockStart: 'var(--s-4)' }}>
            <BlockedAction l={l} labelKey="ops.unfreeze.cta" reasonKey="ops.unfreeze.cta.blocked" />
          </div>
          <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'ops.unfreeze.bothSides')}
          </p>
        </section>
      ) : null}

      {detail === 'none' ? <DetailMissing l={l} /> : null}

      <BasisCard l={l} type={task.type} />

      {detail === 'decision' ? null : <ClosingCard l={l} rule={closingRuleOf(task.type)} />}

      <NextCard l={l} type={task.type} />

      <section className="card" style={{ background: 'var(--c-danger-soft)', boxShadow: 'none' }}>
        <Eyebrow l={l} labelKey="ops.cannot.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'ops.cannot.body')}
        </p>
      </section>
    </>
  );
}
