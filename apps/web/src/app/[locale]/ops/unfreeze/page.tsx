import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { getUnfreeze, unfreezeTargetOf } from '@/fixtures/screens';
import { BlockedAction, Eyebrow, Row } from '@/ui/primitives';

/**
 * Снятие заморозки — операторский экран `O-02`.
 *
 * Цели разморозки (`packages/domain/src/freeze.ts`, `UNFREEZE_TARGETS`) в
 * клиентском кабинете не показываются вовсе: клиенту говорят, что операции
 * приостановлены, деньги на номинальном счёте, решение принимают двое
 * сотрудников и итог сообщается обеим сторонам одновременно.
 *
 * Разморозка не возвращает состояние «как было»: заморозка длилась, и выбор
 * между расчётом и возвратом — решение человека, которое обязано быть записано.
 * Цель — обязательное поле события, а не вывод системы.
 */
export default async function UnfreezePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const l = { dict: dictionaryOf(locale), locale };
  const chosen = unfreezeTargetOf(typeof query.target === 'string' ? query.target : undefined);
  const view = await getUnfreeze(chosen);

  return (
    <>
      <div className="pagehead">
        <Eyebrow l={l} labelKey="ops.screen.unfreeze" />
        <div className="pagehead__row">
          <h1>{t(l.dict, 'ops.unfreeze.title')}</h1>
          <span className="mono faint">
            {view.deal === null ? view.caseId : `${view.deal.ref} · ${view.deal.trancheStatus}`}
          </span>
        </div>
        <p className="pagehead__note">{t(l.dict, 'ops.unfreeze.subtitle')}</p>
      </div>

      <section className="card" aria-labelledby="targets">
        <h2 className="card__title" id="targets">
          {t(l.dict, 'ops.unfreeze.targets.title')}
        </h2>
        <div className="stack stack--tight">
          {view.targets.map((target) => (
            <a
              className="outcome"
              key={target}
              href={`/${locale}/ops/unfreeze?target=${target}`}
              aria-current={target === chosen ? 'true' : undefined}
              style={
                target === chosen
                  ? { borderColor: 'var(--c-refund)', background: 'var(--c-refund-soft)' }
                  : undefined
              }
            >
              <span className="outcome__title">
                <span className="mono">{target}</span> {t(l.dict, `ops.unfreeze.target.${target}.title`)}
              </span>
              <span className="outcome__body">{t(l.dict, `ops.unfreeze.target.${target}.body`)}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="approve">
        <h2 className="card__title" id="approve">
          {t(l.dict, 'ops.unfreeze.decision.title')}
        </h2>
        <div className="rows">
          <Row l={l} labelKey="ops.unfreeze.decision.target">
            <span className="mono">{chosen}</span>
          </Row>
          <Row l={l} labelKey="ops.decision.fourEyes.approvals">
            <span className="mono">
              {view.approvalsCollected} / {view.approvalsRequired}
            </span>
          </Row>
          <Row l={l} labelKey="ops.unfreeze.decision.case">
            <span className="mono">{view.caseId}</span>
          </Row>
        </div>
        <div style={{ marginBlockStart: 'var(--s-4)' }}>
          <BlockedAction l={l} labelKey="ops.unfreeze.cta" reasonKey="ops.unfreeze.cta.blocked" />
        </div>
        <p className="faint" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'ops.unfreeze.bothSides')}
        </p>
      </section>
    </>
  );
}
