import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatDateTime, formatRemaining } from '@/i18n/format';
import { type PerimeterState, PERIMETER_STATES, getRequisites, now, viewerTimeZone } from '@/fixtures/store';
import { beneficiaryFacts } from '@/fixtures/screens';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Badge, BlockedAction, Eyebrow, Row, SecurityBlock, StatusDot } from '@/ui/primitives';

function perimeterOf(value: string | undefined): PerimeterState {
  return PERIMETER_STATES.find((state) => state === value) ?? 'P-07';
}

/**
 * Экран 5 — реквизиты выплаты. Защитный периметр, а не форма.
 *
 * Здесь трение — функция, а не дефект: подмена реквизитов самый вероятный
 * сценарий атаки (`CABINETS.md` §0.3). Отсюда три решения экрана: имя владельца
 * счёта **не вводится** — оно берётся из проверки личности; экран всегда
 * говорит, что сейчас запрещено и почему; блок безопасности стоит над
 * реквизитами, а не в подвале.
 *
 * Состояния периметра `P-*` — экранные. Рядом с ними показан статус из
 * `packages/domain/src/beneficiary.ts` (`draft · name_consistent · verified ·
 * blocked`) и два отдельных факта — «заперто» и «идёт охлаждение». В макете
 * они сведены в один перечень из шести значений; расхождение разрешено в пользу
 * кода, потому что заперты бывают и проверенные реквизиты, а охлаждение идёт
 * поверх любого статуса.
 */
export default async function RequisitesPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const state = perimeterOf(typeof query.state === 'string' ? query.state : undefined);
  const l = { dict: dictionaryOf(locale), locale };
  const view = await getRequisites(state);
  const facts = beneficiaryFacts(state);
  const viewerZone = viewerTimeZone();
  const currentTime = now();

  const tone =
    state === 'P-03' || state === 'P-10'
      ? 'danger'
      : state === 'P-09' || state === 'P-07'
        ? 'warn'
        : state === 'P-06'
          ? 'ok'
          : 'info';
  const editable = state === 'P-01' || state === 'P-06';

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'requisites.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'requisites.subtitle')}</p>
      </div>

      <SecurityBlock l={l} variant="inline" />

      <section className={`state-card state-card--${tone}`} aria-labelledby="perimeter">
        <div className="state-card__head">
          <div className="state-card__top">
            <span className="state-card__label">
              <StatusDot tone={tone} />
              {t(l.dict, 'requisites.perimeter')}
            </span>
            <span className="mono faint">{state}</span>
          </div>
          <h2 className="state-card__title" id="perimeter">
            {t(l.dict, `requisites.state.${state}.title`)}
          </h2>
          <p className="state-card__body">
            {t(l.dict, `requisites.state.${state}.body`, {
              deal: view.lockedByDealRef ?? '',
              attempts: view.attemptsLeft,
            })}
          </p>
        </div>
        <div className="state-card__inner">
          <div className="rows">
            <Row l={l} labelKey="requisites.domainStatus">
              <span className="mono">{facts.status}</span>
            </Row>
            <Row l={l} labelKey="requisites.domainLocked">
              <Badge
                tone={facts.locked ? 'warn' : 'ok'}
                label={t(l.dict, facts.locked ? 'common.yes' : 'common.no')}
              />
            </Row>
            <Row l={l} labelKey="requisites.domainCooling">
              <Badge
                tone={facts.cooling ? 'warn' : 'ok'}
                label={t(l.dict, facts.cooling ? 'common.yes' : 'common.no')}
              />
            </Row>
          </div>
          {view.coolingUntil === null ? null : (
            <p className="faint">
              {t(l.dict, 'requisites.cooling.until', {
                value: formatDateTime(locale, view.coolingUntil, OPERATIONS_TIME_ZONE),
                remaining: formatRemaining(locale, view.coolingUntil - currentTime),
              })}
            </p>
          )}
        </div>
      </section>

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="requisites.why.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'requisites.why.body')}
        </p>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'requisites.why.symmetry', { hours: 48 })}
        </p>
        <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'requisites.why.note')}
        </p>
      </section>

      <section className="card" aria-labelledby="current">
        <h2 className="card__title" id="current">
          {t(l.dict, 'requisites.current')}
        </h2>

        <div className="field">
          <span className="field__label" id="holder-label">
            {t(l.dict, 'requisites.holderName')}
          </span>
          <span className="field__value" aria-labelledby="holder-label" aria-readonly="true">
            {view.holderName}
          </span>
          <span className="locknote">
            <StatusDot tone="info" />
            {t(l.dict, 'requisites.holderName.why')}
          </span>
        </div>

        <div className="field">
          <span className="field__label">{t(l.dict, 'requisites.iban')}</span>
          <span className="field__value field__value--mono">{view.ibanMasked}</span>
        </div>

        <div className="field">
          <span className="field__label">{t(l.dict, 'requisites.bank')}</span>
          <span className="field__value">{view.bank}</span>
        </div>

        <div className="field">
          <span className="field__label">{t(l.dict, 'requisites.verifiedAt')}</span>
          <span className="field__value">
            {formatDate(locale, view.verifiedAt, viewerZone)}{' '}
            <Badge tone="ok" label={t(l.dict, 'requisites.verified')} />
          </span>
        </div>

        <div style={{ marginBlockStart: 'var(--s-4)' }}>
          {editable ? (
            <p className="actions">
              <a className="btn btn--secondary" href={`/${locale}/requisites?state=P-04`}>
                {t(l.dict, 'requisites.change')}
              </a>
            </p>
          ) : (
            <BlockedAction
              l={l}
              labelKey="requisites.change"
              reasonKey={`requisites.change.blocked.${state}`}
              params={{ deal: view.lockedByDealRef ?? '' }}
            />
          )}
        </div>
      </section>

      {state === 'P-04' ? (
        <section className="card" aria-labelledby="test-transfer">
          <h2 className="card__title" id="test-transfer">
            {t(l.dict, 'requisites.test.title')}
          </h2>
          <p className="muted">{t(l.dict, 'requisites.test.howItWorks')}</p>
          <ol className="stack stack--tight" style={{ marginBlockStart: 'var(--s-3)' }}>
            <li className="muted">{t(l.dict, 'requisites.test.step.sent')}</li>
            <li className="muted">{t(l.dict, 'requisites.test.step.find')}</li>
            <li className="muted">{t(l.dict, 'requisites.test.step.enter')}</li>
          </ol>
          <p className="faint" aria-live="polite" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'requisites.test.attemptsLeft', { attempts: view.attemptsLeft })}
          </p>
          <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'requisites.test.notArrived')}
          </p>
        </section>
      ) : null}

      {state === 'P-09' ? (
        <section className="card">
          <h2 className="card__title">{t(l.dict, 'requisites.notMe.title')}</h2>
          <p className="muted">{t(l.dict, 'requisites.notMe.body')}</p>
          <p className="faint" style={{ marginBlockStart: 'var(--s-2)' }}>
            {t(l.dict, 'requisites.notified')}
          </p>
          <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
            <a className="btn" href={`/${locale}/security`}>
              {t(l.dict, 'requisites.notMe.cta')}
            </a>
          </p>
        </section>
      ) : null}

      <section className="card" aria-labelledby="history">
        <h2 className="card__title" id="history">
          {t(l.dict, 'requisites.history')}
        </h2>
        <ul>
          {view.history.map((item) => (
            <li className="record" key={item.at}>
              <div className="record__top">
                <span className="record__label">{t(l.dict, item.changeKey)}</span>
                <span className="record__meta">{formatDate(locale, item.at, viewerZone)}</span>
              </div>
              <span className="record__meta">{t(l.dict, item.actorKey)}</span>
              <span className="record__meta">{t(l.dict, item.confirmationKey)}</span>
            </li>
          ))}
        </ul>
      </section>

      <nav className="chips" aria-label={t(l.dict, 'requisites.states.nav')}>
        {PERIMETER_STATES.map((item) => (
          <a
            className="chip"
            key={item}
            href={`/${locale}/requisites?state=${item}`}
            aria-current={item === state ? 'true' : undefined}
          >
            <span className="mono">{item}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
