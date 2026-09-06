import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatRemaining } from '@/i18n/format';
import { getOpsQueue, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { getDecision, getReconciliation, getUnfreeze, unfreezeTargetOf } from '@/fixtures/screens';
import { BlockedAction, DeadlineTimer, Eyebrow, Row } from '@/ui/primitives';
import {
  BasisCard,
  BreaksList,
  CaseFacts,
  ClosingCard,
  DetailMissing,
  EvidencePackage,
  ExternalWaitCard,
  FieldsCompare,
  GuardList,
  NextCard,
  OutcomesCard,
  PostingsCard,
  SubjectCard,
  WhyCard,
} from '@/ui/ops';
import { closingRuleOf, detailKindOf, evidenceOf, externalFactOf } from '@/ui/ops-work';

/**
 * Карточка задачи — то, ради чего очередь вообще существует.
 *
 * Одна и та же рамка у всех семнадцати видов задач, и порядок блоков не
 * меняется никогда:
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
 * Постоянство порядка важнее плотности: оператор разбирает за смену разные
 * задачи, и место, где написано «чем подтверждать», обязано быть одним и тем же
 * во всех.
 *
 * Девять видов разбора, добавленных последними, рамку не расширяют: у них тот
 * же порядок блоков, а «разбор» наполнен фактами, которые детектор уже посчитал
 * (`CaseFacts`). Вторая рамка под них не заводилась — она и была бы тем самым
 * «ещё одним экраном», из-за которого оператор ищет работу глазами.
 *
 * ## Задача, на которой ничего не решают
 *
 * Восемнадцатый вид — простой заявки на вывод — рамку не расширяет тоже, но
 * **сокращает**: блоков 4, 6 и 7 у него нет ни одного. Это не экономия места, а
 * то же правило, что и везде здесь: рёбер, которые человек мог бы выбрать на
 * этом экране, у машины вывода не существует (`WITHDRAWAL_CLOCK_EVENTS` —
 * `Record<…, null>`), значит, нет ни исходов, ни доказательства исхода, ни
 * правила закрытия. Показать все три «на всякий случай» — обещать переход,
 * которого нет; отдельно про один из них: повтор поручения из «исход
 * неизвестен» запрещён без сверки (красная линия №8), и кнопки, дающей его,
 * здесь быть не может ни под каким названием.
 *
 * На месте блока «что вы решаете» стоит ответ, а не пустая рамка: решения нет,
 * и сказано почему (`OutcomesCard`).
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
  /* `null` у обоих означает одно: решения на этой карточке не принимают, и
     карточки основания и правила закрытия не рендерятся вовсе. */
  const evidence = evidenceOf(task.type);
  const closing = closingRuleOf(task.type);
  const subject = task.subject;
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
          <span className="mono faint">
            {subject.kind === 'deal' ? subject.dealRef : subject.withdrawalId}
          </span>
        </div>
        <p className="pagehead__note">
          {t(
            l.dict,
            subject.kind === 'deal'
              ? `ops.money.${subject.moneyState}.note`
              : 'ops.task.subject.withdrawal.note',
          )}
        </p>
      </div>

      <SubjectCard l={l} task={task} />

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

      {detail === 'decision' && decision !== null && subject.kind === 'deal' && decision.deal.id === subject.dealId ? (
        <>
          <FieldsCompare l={l} fields={decision.fields} />
          <div className="split">
            <EvidencePackage l={l} items={decision.evidence} />
            {closing === null ? null : (
              <ClosingCard
                l={l}
                rule={closing}
                approvalsCollected={decision.approvalsCollected}
                approvalsRequired={decision.approvalsRequired}
                preparedBySelf={decision.preparedBySelf}
              />
            )}
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

      {detail === 'facts' && task.facts.length > 0 ? (
        <CaseFacts
          l={l}
          facts={task.facts}
          operationsZone={OPERATIONS_TIME_ZONE}
          /* Величины простоя считает не детектор, а часы заявки. */
          noteKey={subject.kind === 'deal' ? 'ops.facts.note' : 'ops.facts.note.stall'}
        />
      ) : null}

      {detail === 'none' || (detail === 'facts' && task.facts.length === 0) ? (
        <DetailMissing l={l} />
      ) : null}

      {evidence === null ? null : <BasisCard l={l} kinds={evidence} />}

      {detail === 'decision' || closing === null ? null : <ClosingCard l={l} rule={closing} />}

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
