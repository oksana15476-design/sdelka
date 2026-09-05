import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { LegalSlot, legalSlotPending, SecurityBlock, StatusDot } from '@/ui/primitives';

/** Развёрнутый раздел безопасности и помощи `B-07`: сюда ведёт «сообщить о контакте». */
const NEVER = ['phone', 'email', 'messenger', 'otherAccount'] as const;

const DOES = ['1', '2', '3', '4', '5', '6', '7'] as const;

const DOES_NOT = ['1', '2', '3', '4', '5', '6'] as const;

export default async function SecurityPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'security.page.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'security.page.subtitle')}</p>
      </div>

      <SecurityBlock l={l} variant="inline" />

      <section className="card" aria-labelledby="never">
        <h2 className="card__title" id="never">
          {t(l.dict, 'security.never.title')}
        </h2>
        <div className="security__list">
          {NEVER.map((key) => (
            <p className="security__item" key={key}>
              <StatusDot tone="danger" />
              <span>{t(l.dict, `security.never.${key}`)}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="verify">
        <h2 className="card__title" id="verify">
          {t(l.dict, 'security.verify.title')}
        </h2>
        <p className="muted">{t(l.dict, 'security.verify.body')}</p>
      </section>

      <section className="card" aria-labelledby="we-do">
        <h2 className="card__title" id="we-do">
          {t(l.dict, 'trust.weDo.title')}
        </h2>
        <div className="security__list">
          {DOES.map((key) => (
            <p className="security__item" key={key}>
              <StatusDot tone="ok" />
              <span>{t(l.dict, `trust.weDo.${key}`, { bank: t(l.dict, 'glossary.custodian') })}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="we-do-not">
        <h2 className="card__title" id="we-do-not">
          {t(l.dict, 'trust.weDoNot.title')}
        </h2>
        <div className="security__list">
          {DOES_NOT.map((key) => (
            <p className="security__item" key={key}>
              <StatusDot tone="warn" />
              <span>{t(l.dict, `trust.weDoNot.${key}`)}</span>
            </p>
          ))}
        </div>
        {/* `trust.weDoNot.7` — заявление о регулируемом статусе. Юридическое
            ревью его не пропустило (`LEGAL-REVIEW.md` Ю-37, ⛔): называть себя
            провайдером платёжных услуг до получения статуса нельзя. До
            формулировки юриста строки нет — ни черновика, ни пометки о нём:
            слот в `PENDING_LEGAL_SLOTS` и не рендерится. */}
        {legalSlotPending('trust.weDoNot.7') ? null : (
          <div style={{ marginBlockStart: 'var(--s-3)' }}>
            <LegalSlot l={l} bodyKey="trust.weDoNot.7" />
          </div>
        )}
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'trust.boundary')}
        </p>
      </section>

      <section className="card" aria-labelledby="report">
        <h2 className="card__title" id="report">
          {t(l.dict, 'security.report.title')}
        </h2>
        <p className="muted">{t(l.dict, 'security.report.body', { sla: t(l.dict, 'security.sla') })}</p>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'security.report.note')}
        </p>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'security.report.pause')}
        </p>
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn" href={`/${locale}/security`}>
            {t(l.dict, 'security.report.cta')}
          </a>
        </p>
      </section>
    </>
  );
}
