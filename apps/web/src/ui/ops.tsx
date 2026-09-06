import type { ReactNode } from 'react';
import type { CurrencyCode, Money } from '@sdelka/money';
import {
  formatBasisPoints,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRemaining,
} from '@/i18n/format';
import { t } from '@/i18n/translate';
import { GUARD_LABEL_KEY, type LabelledGuardId } from './guards';
import type { CaseFact, DeadlineView, OpsTask } from '@/fixtures/store';
import type { BreakItem, FieldMatch } from '@/fixtures/screens';
import { type StateTone, MONEY_STATE_TONE } from '@/view/money-state';
import type { L10n } from './l10n';
import { Amount, Badge, BlockedAction, Eyebrow, ListRow, Row, StatusDot } from './primitives';
import {
  type ClosingRule,
  type EvidenceKind,
  type ExternalFact,
  type Urgency,
  externalFactOf,
  outcomesOf,
  taskHref,
  urgencyOf,
} from './ops-work';

/**
 * Части консоли операций.
 *
 * Собраны так, чтобы очередь и карточка задачи говорили одними и теми же
 * блоками: строка очереди — это свёрнутая карточка, а карточка — развёрнутая
 * строка. Ни одного нового класса оформления здесь не заведено: используется
 * инвентарь дизайн-системы (`docs/handoff/prototypes/Сделка - дизайн-система`,
 * `IMPLEMENTATION.md` §1), а не собственные стили.
 *
 * Ни один компонент не принимает пропом функцию-компонент: через границу едут
 * только данные и ключи (`ui/l10n.ts`).
 */

/* ------------------------------------------------------------------ сроки */

const URGENCY_TONE: Readonly<Record<Urgency, StateTone>> = Object.freeze({
  overdue: 'danger',
  soon: 'warn',
  later: 'wait',
  paused: 'info',
});

/**
 * Срок строкой. Три разные вещи не смешиваются: просрочка называется
 * просрочкой, остановленные часы — остановленными, отсутствие срока —
 * отсутствием. Относительное время никогда не единственное представление: в
 * карточке задачи рядом стоит `DeadlineTimer` с двумя зонами.
 */
export function DeadlineChip({
  l,
  deadline,
  now,
}: {
  readonly l: L10n;
  readonly deadline: DeadlineView | null;
  readonly now: number;
}): ReactNode {
  const urgency = urgencyOf(deadline, now);
  if (deadline === null) {
    return <Badge tone="wait" label={t(l.dict, 'ops.task.noDeadline')} />;
  }
  if (deadline.at === null) {
    return <Badge tone={URGENCY_TONE.paused} label={t(l.dict, 'deadline.paused.title')} />;
  }
  const distance = formatRemaining(l.locale, Math.abs(deadline.at - now));
  return (
    <Badge
      tone={URGENCY_TONE[urgency]}
      label={t(l.dict, urgency === 'overdue' ? 'ops.task.overdue' : 'ops.task.due', {
        value: distance,
      })}
    />
  );
}

/* ---------------------------------------------------------- строка очереди */

/**
 * Строка очереди работы.
 *
 * Порядок чтения задан сверху вниз и одинаков у всех строк: **что за задача →
 * сколько времени → по какой сделке и где деньги → сколько денег → одно
 * действие**. Сумма стоит отдельной строкой, а не внутри предложения: иначе
 * ломается согласование с числительным (`IMPLEMENTATION.md` §4).
 */
export function TaskRow({
  l,
  task,
  now,
}: {
  readonly l: L10n;
  readonly task: OpsTask;
  readonly now: number;
}): ReactNode {
  const urgency = urgencyOf(task.deadline, now);
  const claimed = task.claimedBy !== null;
  const subject = task.subject;
  /*
   * Консоль на телефоне показывает только то, ради чего дежурного будят ночью,
   * — утверждение выплаты. Остальное требует документов и второй проверки; на
   * телефоне их не разбирают, и делать вид, что разбирают, опаснее, чем честно
   * закрыть (`SCREENS.md` §1.3).
   */
  const night = task.type === 'approvePayout';
  const modifier = `${urgency === 'overdue' ? ' task--overdue' : ''}${claimed ? ' task--claimed' : ''}${night ? '' : ' task--desktop-only'}`;
  return (
    <li className={`task${modifier}`}>
      {/* Верхняя строка — два разных вопроса: где деньги и сколько времени.
          Вид задачи здесь не повторяется: он стоит заголовком строкой ниже, и
          повтор одного слова дважды подряд читается как сбой вёрстки. */}
      {/* Слева — где деньги, справа — сколько времени. У задачи без сделки
          положения денег нет, и на его месте стоит не пустота и не прочерк, а
          то, чем эта задача вообще заведена: заявка стоит дольше норматива.
          Второй значок рядом при этом говорит про **срок операции**, и он
          может быть не просрочен — расхождение намеренное, оно и есть предмет
          задачи (`ops.task.subject.age.note`). */}
      <div className="task__top">
        {subject.kind === 'deal' ? (
          <Badge
            tone={MONEY_STATE_TONE[subject.moneyState]}
            label={t(l.dict, `ops.money.${subject.moneyState}.label`)}
          />
        ) : (
          <Badge tone="warn" label={t(l.dict, 'ops.task.stalled')} />
        )}
        <DeadlineChip l={l} deadline={task.deadline} now={now} />
      </div>

      <h3 className="task__title">
        <a href={taskHref(l.locale, task.id)}>{t(l.dict, `ops.task.type.${task.type}`)}</a>
      </h3>

      {subject.kind === 'deal' ? (
        <>
          <p className="deal-card__meta">
            <span className="mono">{subject.dealRef}</span> · {subject.address}
          </p>
          <Amount l={l} value={subject.amount} size="lead" labelKey="ops.task.amountLabel" />
        </>
      ) : (
        <>
          <p className="deal-card__meta">
            <span className="mono">{subject.withdrawalId}</span>
          </p>
          {/* На месте суммы — причина её отсутствия, а не ноль и не прочерк:
              пересчёт в валюту очереди требует официального курса на дату. */}
          <p className="muted">{t(l.dict, 'ops.task.rank.none')}</p>
        </>
      )}

      <p className="faint">{t(l.dict, 'ops.task.age', { value: formatRemaining(l.locale, task.ageMs) })}</p>

      {claimed ? (
        <BlockedAction
          l={l}
          labelKey="ops.task.action.open"
          reasonKey="ops.task.claimedBy"
          params={{ operator: task.claimedBy ?? '' }}
        />
      ) : (
        <p className="actions">
          <a
            className={`btn${externalFactOf(task.type) === null ? '' : ' btn--secondary'}`}
            href={taskHref(l.locale, task.id)}
          >
            {t(l.dict, 'ops.task.action.open')}
          </a>
        </p>
      )}
    </li>
  );
}

/**
 * Предмет задачи: о чём она и сколько стоит в очереди.
 *
 * Две раскладки, а не одна с прочерками. У задачи о сделке названы сделка,
 * объект, положение денег и сумма; у задачи о заявке на вывод трёх из них нет
 * вовсе — и каждое отсутствие названо **словами и причиной**, а не чертой.
 * Черта отвечает «здесь ничего», а оператору нужен ответ «этого не бывает, и
 * вот почему»: сделки у вывода не существует, лицо у заявки не хранится, сумма
 * не пересчитана, потому что курс — внешний факт.
 *
 * Возраст стоит в обеих раскладках на одном месте, а у заявки к нему добавлена
 * подпись: он считается от входа в состояние и не двигается ответом банка — в
 * отличие от срока операции, который стоит выше.
 */
export function SubjectCard({ l, task }: { readonly l: L10n; readonly task: OpsTask }): ReactNode {
  const subject = task.subject;
  return (
    <section className="card" aria-labelledby="subject">
      <h2 className="card__title" id="subject">
        {t(l.dict, 'ops.task.subject.title')}
      </h2>
      <div className="rows">
        {subject.kind === 'deal' ? (
          <>
            <Row l={l} labelKey="ops.task.subject.deal">
              <a className="mono" href={`/${l.locale}/deals/${subject.dealId}`}>
                {subject.dealRef}
              </a>
            </Row>
            <Row l={l} labelKey="ops.task.subject.property">
              <span>{subject.address}</span>
            </Row>
            <Row l={l} labelKey="ops.task.subject.money">
              <Badge
                tone={MONEY_STATE_TONE[subject.moneyState]}
                label={t(l.dict, `ops.money.${subject.moneyState}.label`)}
              />
            </Row>
            <Row l={l} labelKey="ops.task.amountLabel">
              <Amount l={l} value={subject.amount} />
            </Row>
          </>
        ) : (
          <>
            <Row l={l} labelKey="ops.task.subject.withdrawal">
              <span className="mono">{subject.withdrawalId}</span>
            </Row>
            <Row l={l} labelKey="ops.task.subject.deal">
              <span className="muted">{t(l.dict, 'ops.task.subject.deal.none')}</span>
            </Row>
            <Row l={l} labelKey="ops.task.subject.party">
              <span className="muted">{t(l.dict, 'ops.task.subject.party.none')}</span>
            </Row>
            <Row l={l} labelKey="ops.task.rank.label">
              <span className="muted">{t(l.dict, 'ops.task.rank.none')}</span>
            </Row>
          </>
        )}
        <Row l={l} labelKey="ops.task.subject.age">
          <span className="mono">{formatRemaining(l.locale, task.ageMs)}</span>
        </Row>
      </div>
      {subject.kind === 'deal' ? null : (
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.task.subject.age.note')}
        </p>
      )}
    </section>
  );
}

/**
 * Полка очереди: заголовок, счётчик и правило, по которому задачи сюда попали.
 * Правило написано словами — иначе полка «ждём внешнего факта» читается как
 * «отложенные», а это не одно и то же.
 */
export function QueueShelf({
  l,
  titleKey,
  noteKey,
  count,
  wide = false,
  children,
}: {
  readonly l: L10n;
  readonly titleKey: string;
  readonly noteKey: string;
  readonly count: number;
  /** Полка, которую на телефоне не показываем вовсе: ночью её не разбирают. */
  readonly wide?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className={`group${wide ? ' wide-only' : ''}`} aria-labelledby={titleKey}>
      <div className="group__title">
        <h2 id={titleKey}>{t(l.dict, titleKey)}</h2>
        {/* Счётчик — только на широком экране. На телефоне консоль показывает
            одну задачу из полки (утверждение выплаты), и число «шесть» над
            одной карточкой было бы неправдой, а не сокращением. */}
        <span className="mono faint wide-only">{formatNumber(l.locale, count)}</span>
      </div>
      <p className="muted">{t(l.dict, noteKey)}</p>
      <ul className="ops-grid">{children}</ul>
    </section>
  );
}

/* -------------------------------------------------- блоки карточки задачи */

/**
 * Что человек решает: закрытый перечень исходов, все одного веса.
 *
 * Карточка, показывающая только «хороший» исход, читается как подсказка, что
 * выбрать, — а выбирать здесь нечего подсказывать: у каждого исхода своё ребро
 * в автомате, и лишнего ребра нет.
 */
export function OutcomeList({
  l,
  keys,
  chosen,
  hrefOf,
}: {
  readonly l: L10n;
  readonly keys: readonly string[];
  readonly chosen?: string | undefined;
  readonly hrefOf?: Readonly<Record<string, string>> | undefined;
}): ReactNode {
  return (
    <div className="outcomes">
      {keys.map((key) => {
        const body = (
          <>
            <span className="outcome__title">{t(l.dict, `${key}.title`)}</span>
            <span className="outcome__body">{t(l.dict, `${key}.body`)}</span>
          </>
        );
        const href = hrefOf?.[key];
        if (href === undefined) {
          return (
            <div className="outcome" key={key}>
              {body}
            </div>
          );
        }
        return (
          <a
            className="outcome"
            key={key}
            href={href}
            aria-current={key === chosen ? 'true' : undefined}
            style={
              key === chosen
                ? { borderColor: 'var(--c-refund)', background: 'var(--c-refund-soft)' }
                : undefined
            }
          >
            {body}
          </a>
        );
      })}
    </div>
  );
}

/**
 * Чем решение подтверждается. Три обязательных поля записи решения названы
 * прямо: без версии политики решение нельзя воспроизвести через два года, без
 * причин — объяснить, без доказательства — обосновать.
 */
export function BasisCard({
  l,
  kinds,
}: {
  readonly l: L10n;
  /**
   * Виды доказательств — **приходят снаружи**, а не спрашиваются здесь по виду
   * задачи. Причина одна: у вида задачи, на котором решения не принимают,
   * доказательства нет вовсе (`evidenceOf` отвечает `null`), и карточка тогда
   * не рендерится целиком. Спроси она сама — пришлось бы подставить пустой
   * список, то есть нарисовать пустую строку вместо ответа.
   */
  readonly kinds: readonly EvidenceKind[];
}): ReactNode {
  return (
    <section className="card" aria-labelledby="basis">
      <h2 className="card__title" id="basis">
        {t(l.dict, 'ops.basis.title')}
      </h2>
      <div className="rows">
        <Row l={l} labelKey="ops.basis.evidence">
          {kinds.map((kind) => t(l.dict, `ops.evidence.${kind}`)).join(' · ')}
        </Row>
        <Row l={l} labelKey="ops.basis.policyVersion">
          <Badge tone="info" label={t(l.dict, 'ops.basis.required')} />
        </Row>
        <Row l={l} labelKey="ops.basis.reasons">
          <Badge tone="info" label={t(l.dict, 'ops.basis.required')} />
        </Row>
      </div>
      <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, 'ops.basis.note')}
      </p>
      <p className="faint">{t(l.dict, 'ops.basis.audit')}</p>
    </section>
  );
}

/**
 * Кто закрывает задачу и почему не вы один. Правило названо словами до нажатия,
 * а не отказом в момент нажатия.
 */
export function ClosingCard({
  l,
  rule,
  approvalsCollected,
  approvalsRequired,
  preparedBySelf,
}: {
  readonly l: L10n;
  readonly rule: ClosingRule;
  readonly approvalsCollected?: number | undefined;
  readonly approvalsRequired?: number | undefined;
  readonly preparedBySelf?: boolean | undefined;
}): ReactNode {
  return (
    <section className="card" aria-labelledby="closing">
      <h2 className="card__title" id="closing">
        {t(l.dict, 'ops.closing.title')}
      </h2>
      <div className="rows">
        <Row l={l} labelKey="ops.closing.rule">
          {t(l.dict, `ops.closing.rule.${rule}`)}
        </Row>
        {approvalsRequired === undefined || approvalsCollected === undefined ? null : (
          <Row l={l} labelKey="ops.decision.fourEyes.approvals">
            <span className="mono">
              {approvalsCollected} / {approvalsRequired}
            </span>
          </Row>
        )}
      </div>
      <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, `ops.closing.rule.${rule}.note`)}
      </p>
      {preparedBySelf === true ? (
        <p className="faint">{t(l.dict, 'ops.payout.blocked.samePreparer')}</p>
      ) : null}
    </section>
  );
}

/**
 * Ждём внешнего факта. Отдельный блок, а не строчка в подписи: пока факта нет,
 * у человека здесь работы нет, и очередь обязана сказать это прямо, иначе
 * задачу будут открывать по кругу.
 */
export function ExternalWaitCard({ l, fact }: { readonly l: L10n; readonly fact: ExternalFact }): ReactNode {
  return (
    <section className="card card--quiet" aria-labelledby="wait">
      <Eyebrow l={l} labelKey="ops.wait.label" />
      <h2 className="card__title" id="wait" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, `ops.wait.${fact}.title`)}
      </h2>
      <p className="muted">{t(l.dict, `ops.wait.${fact}.body`)}</p>
      <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, `ops.wait.${fact}.next`)}
      </p>
    </section>
  );
}

/**
 * Разбор, тела которого в этом слое ещё нет.
 *
 * Показывается видимым состоянием, а не пустотой: рамка решения на месте, а
 * материалов разбора нет — это разные вещи, и оператор обязан различать их с
 * первого взгляда.
 */
export function DetailMissing({ l }: { readonly l: L10n }): ReactNode {
  return (
    <section className="card card--quiet" aria-labelledby="detail">
      <h2 className="card__title" id="detail">
        {t(l.dict, 'ops.detail.missing.title')}
      </h2>
      <p className="muted">{t(l.dict, 'ops.detail.missing.body')}</p>
    </section>
  );
}

/**
 * Разбор для видов задач, у которых своего экрана нет: факты, посчитанные
 * детектором, строками одной формы.
 *
 * Одна карточка на девять видов — намеренно. Девять собственных разборов дали
 * бы девять разных мест, где лежит «на чём строится решение», а постоянство
 * места здесь важнее плотности: оператор за смену открывает разные задачи и
 * обязан находить факты там же, где нашёл их в прошлый раз.
 *
 * Форматирует всё локаль: суммы — `Intl` по целым минорным единицам, доли — по
 * базисным пунктам, моменты — в зоне операций. Ни одной строки, склеенной в
 * фикстуре: склеенная строка не переводится и ломает грузинский формат.
 */
export function CaseFacts({
  l,
  facts,
  operationsZone,
  noteKey = 'ops.facts.note',
}: {
  readonly l: L10n;
  readonly facts: readonly CaseFact[];
  readonly operationsZone: string;
  /**
   * Подпись под фактами. По умолчанию — «посчитаны детектором»: так и есть у
   * девяти видов разбора комплаенса. У простоя заявки на вывод детектора нет
   * вовсе — величины считают часы заявки, — и подпись по умолчанию была бы
   * мелкой неправдой в самом низу карточки.
   */
  readonly noteKey?: string;
}): ReactNode {
  return (
    <section className="card" aria-labelledby="facts">
      <h2 className="card__title" id="facts">
        {t(l.dict, 'ops.facts.title')}
      </h2>
      <div className="rows">
        {facts.map((fact) => (
          <Row l={l} labelKey={fact.labelKey} key={fact.labelKey}>
            {fact.kind === 'phrase' ? <span>{t(l.dict, fact.valueKey)}</span> : null}
            {fact.kind === 'code' ? <span className="mono">{fact.value}</span> : null}
            {fact.kind === 'money' ? <Amount l={l} value={fact.value} /> : null}
            {fact.kind === 'delta' ? <Amount l={l} value={fact.value} signed /> : null}
            {fact.kind === 'moment' ? (
              <span className="mono">{formatDateTime(l.locale, fact.at, operationsZone)}</span>
            ) : null}
            {fact.kind === 'span' ? <span className="mono">{formatRemaining(l.locale, fact.ms)}</span> : null}
            {fact.kind === 'count' ? <span className="mono">{formatNumber(l.locale, fact.value)}</span> : null}
            {fact.kind === 'share' ? (
              <span className="mono">{formatBasisPoints(l.locale, fact.bp)}</span>
            ) : null}
            {fact.kind === 'signal' ? (
              <Badge tone={fact.tone} label={t(l.dict, fact.textKey)} />
            ) : null}
          </Row>
        ))}
      </div>
      <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, noteKey)}
      </p>
    </section>
  );
}

/* ------------------------------------------------------- разбор: O-05 */

/** Сверка пяти полей: сетка, а не таблица — колонок фиксированное число. */
export function FieldsCompare({
  l,
  fields,
}: {
  readonly l: L10n;
  readonly fields: readonly FieldMatch[];
}): ReactNode {
  return (
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
        {fields.map((field) => (
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
  );
}

export function EvidencePackage({
  l,
  items,
}: {
  readonly l: L10n;
  readonly items: readonly { readonly id: string; readonly present: boolean; readonly note: string | null }[];
}): ReactNode {
  return (
    <section className="card" aria-labelledby="evidence">
      <h2 className="card__title" id="evidence">
        {t(l.dict, 'ops.decision.evidence.title')}
      </h2>
      <div className="rows">
        {items.map((item) => (
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
  );
}

/**
 * Чего не хватает, чтобы задачу закрыть. Причины названы именами проверок из
 * `packages/domain/src/guards.ts`: оператор ищет не «почему серо», а какое
 * условие не проходит.
 *
 * ## Подпись — **имя условия**, а не приговор
 *
 * Один и тот же ключ подписывает пункт и в пройденных, и в непройденных: список
 * здесь один, разведён он точкой состояния. Подпись, написанная отрицанием
 * («Второе утверждение не набрано»), в пройденных читается наоборот — зелёная
 * точка рядом с «не набрано». Поэтому все подписи — нейтральные названия
 * условия, а исход несут точка и её текстовая пара.
 *
 * ## Исход — не одним цветом
 *
 * `StatusDot` объявлен `aria-hidden`, то есть до правки пройденное от
 * непройденного отличалось **только цветом**: ни текста, ни формы. Рядом с
 * каждой точкой теперь стоит скрытая подпись исхода — то же правило, по
 * которому статус нигде в проекте не передаётся одним цветом (`tokens.css`).
 */
export function GuardList({
  l,
  failed,
  passed,
}: {
  readonly l: L10n;
  readonly failed: readonly LabelledGuardId[];
  readonly passed: readonly LabelledGuardId[];
}): ReactNode {
  const item = (guard: LabelledGuardId, ok: boolean): ReactNode => (
    <p className="security__item" key={guard}>
      <StatusDot tone={ok ? 'ok' : 'danger'} />
      <span>
        <span className="visually-hidden">
          {t(l.dict, ok ? 'ops.guard.state.passed' : 'ops.guard.state.failed')}
        </span>
        {t(l.dict, GUARD_LABEL_KEY[guard])} <span className="mono">{guard}</span>
      </span>
    </p>
  );
  return (
    <div className="security__list">
      {failed.map((guard) => item(guard, false))}
      {passed.map((guard) => item(guard, true))}
    </div>
  );
}

/* ------------------------------------------------------- разбор: O-06 */

export function BreaksList({
  l,
  items,
  oldestHours,
  targetHours,
}: {
  readonly l: L10n;
  readonly items: readonly BreakItem[];
  readonly oldestHours: number;
  readonly targetHours: number;
}): ReactNode {
  return (
    <section className="card" aria-labelledby="breaks">
      <div className="state-card__top">
        <h2 className="card__title" id="breaks">
          {t(l.dict, 'ops.recon.breaks.title')}
        </h2>
        <span className="mono faint">
          {t(l.dict, 'ops.recon.breaks.age', {
            oldest: formatRemaining(l.locale, oldestHours * 3_600_000),
            target: formatRemaining(l.locale, targetHours * 3_600_000),
          })}
        </span>
      </div>
      <div className="list">
        {items.map((item) => (
          <ListRow
            key={item.id}
            tone={item.kind === 'noPair' ? 'accent' : 'plain'}
            label={t(l.dict, `ops.recon.break.${item.kind}`)}
            meta={`${item.ref} · ${item.status} · ${formatRemaining(l.locale, item.ageHours * 3_600_000)}`}
            value={
              <>
                <Amount l={l} value={item.amount} />
                {item.difference === null ? null : (
                  <span className="list__meta">
                    {t(l.dict, 'ops.recon.difference', {
                      value: formatMoney(l.locale, item.difference),
                    })}
                  </span>
                )}
              </>
            }
          />
        ))}
      </div>
      <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, 'ops.payout.unknown.note')}
      </p>
    </section>
  );
}

export function PostingsCard({
  l,
  postings,
  total,
}: {
  readonly l: L10n;
  readonly postings: readonly { readonly id: string; readonly amount: Money<CurrencyCode> }[];
  readonly total: Money<CurrencyCode>;
}): ReactNode {
  return (
    <section className="card" aria-labelledby="postings">
      <h2 className="card__title" id="postings">
        {t(l.dict, 'ops.recon.journal.title')}
      </h2>
      <div className="rows">
        {postings.map((posting) => (
          <Row l={l} labelKey={`ops.recon.posting.${posting.id}`} key={posting.id}>
            <Amount l={l} value={posting.amount} signed size="muted" />
          </Row>
        ))}
        <Row l={l} labelKey="ops.recon.total" total>
          <Amount l={l} value={total} />
        </Row>
      </div>
      <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
        {t(l.dict, 'ops.recon.journal.note')}
      </p>
    </section>
  );
}

/* -------------------------------------------------------- рамка задачи */

/**
 * Почему задача оказалась у человека. Первый блок карточки: без него оператор
 * начинает с «что тут не так», а обязан начинать с «что от меня требуется».
 */
export function WhyCard({ l, type }: { readonly l: L10n; readonly type: OpsTask['type'] }): ReactNode {
  return (
    <section className="card" style={{ background: 'var(--c-warn-soft)', boxShadow: 'none' }}>
      <Eyebrow l={l} labelKey="ops.decision.why.title" />
      <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
        {t(l.dict, `ops.why.${type}`)}
      </p>
    </section>
  );
}

/** Что произойдёт после решения — по каждому виду задачи своя строка. */
export function NextCard({ l, type }: { readonly l: L10n; readonly type: OpsTask['type'] }): ReactNode {
  return (
    <section className="card card--quiet" aria-labelledby="next">
      <h2 className="card__title" id="next">
        {t(l.dict, 'ops.next.title')}
      </h2>
      <p className="muted">{t(l.dict, `ops.next.${type}`)}</p>
    </section>
  );
}

/**
 * Перечень исходов задачи одним блоком: заголовок, перечень и правило выбора.
 *
 * ## Когда исходов нет ни одного
 *
 * Такой вид задачи существует ровно один — простой заявки на вывод, — и блок у
 * него не исчезает и не остаётся пустой рамкой. Пустая рамка на месте «что вы
 * решаете» читается как поломка: оператор ищет кнопки, которых нет, и решает,
 * что экран не догрузился. Поэтому здесь стоит **ответ**: решения на этой
 * карточке нет, и вот почему.
 *
 * Заголовок при этом меняется вместе с содержимым. «Что вы решаете» над
 * объяснением, что решать нечего, — вопрос без ответа, и он хуже пустоты.
 */
export function OutcomesCard({
  l,
  type,
  chosen,
  hrefOf,
}: {
  readonly l: L10n;
  readonly type: OpsTask['type'];
  readonly chosen?: string | undefined;
  readonly hrefOf?: Readonly<Record<string, string>> | undefined;
}): ReactNode {
  const keys = outcomesOf(type);
  if (keys.length === 0) {
    return (
      <section className="card card--quiet" aria-labelledby="outcomes">
        <h2 className="card__title" id="outcomes">
          {t(l.dict, 'ops.outcomes.none.title')}
        </h2>
        <p className="muted">{t(l.dict, 'ops.outcomes.none.body')}</p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="outcomes">
      <h2 className="card__title" id="outcomes">
        {t(l.dict, 'ops.outcomes.title')}
      </h2>
      {/* Правило закрытия здесь не повторяется: оно стоит отдельным блоком
          ниже вместе с разбором «почему не вы один». Одна и та же строка,
          показанная дважды на одном экране, читается как сбой, а не как
          напоминание. */}
      <OutcomeList l={l} keys={keys} chosen={chosen} hrefOf={hrefOf} />
    </section>
  );
}
