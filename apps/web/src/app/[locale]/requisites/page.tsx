import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatDateTime, formatRemaining } from '@/i18n/format';
import { type PerimeterState, PERIMETER_STATES, getRequisites, now, viewerTimeZone } from '@/fixtures/store';
import { OPERATIONS_TIME_ZONE } from '@/fixtures/engine';
import { Badge, BlockedAction, SecurityBlock, StatusDot } from '@/ui/primitives';

function perimeterOf(value: string | undefined): PerimeterState {
  return PERIMETER_STATES.find((state) => state === value) ?? 'P-07';
}

/**
 * Экран 5 — реквизиты выплаты. Защитный периметр, а не форма.
 *
 * Здесь трение — функция, а не дефект: подмена реквизитов самый вероятный
 * сценарий атаки (`CABINETS.md` §0.3). Отсюда три решения экрана:
 * имя владельца счёта **не вводится** — оно берётся из проверки личности и
 * показывается нередактируемым; экран всегда говорит, что сейчас запрещено и
 * почему, а не только показывает поля; блок безопасности стоит над реквизитами,
 * а не в подвале.
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
  const viewerZone = viewerTimeZone();
  const currentTime = now();

  const tone =
    state === 'P-03' || state === 'P-10' ? 'danger' : state === 'P-09' || state === 'P-07' ? 'warn' : state === 'P-06' ? 'ok' : 'info';
  const editable = state === 'P-01' || state === 'P-06';

  return (
    <div className="shell stack--loose stack">
      <div className="pagehead">
        <h1>{t(l.dict, 'requisites.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'requisites.subtitle')}</p>
      </div>

      <SecurityBlock l={l} variant="inline" />

      <section className={`card where where--${tone}`} aria-labelledby="perimeter">
        <div className="where__head">
          <StatusDot tone={tone} />
          <div>
            <h2 className="where__title" id="perimeter">
              {t(l.dict, `requisites.state.${state}.title`)}
            </h2>
            <p className="where__body">
              {t(l.dict, `requisites.state.${state}.body`, {
                deal: view.lockedByDealRef ?? '',
                attempts: view.attemptsLeft,
              })}
            </p>
          </div>
        </div>
        {view.coolingUntil === null ? null : (
          <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
            {t(l.dict, 'requisites.cooling.until', {
              value: formatDateTime(locale, view.coolingUntil, OPERATIONS_TIME_ZONE),
              remaining: formatRemaining(locale, view.coolingUntil - currentTime),
            })}
          </p>
        )}
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
        </section>
      ) : null}

      {state === 'P-09' ? (
        <section className="card">
          <h2 className="card__title">{t(l.dict, 'requisites.notMe.title')}</h2>
          <p className="muted">{t(l.dict, 'requisites.notMe.body')}</p>
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
    </div>
  );
}
