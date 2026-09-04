import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { Eyebrow, SecurityBlock, StatusDot } from '@/ui/primitives';

/**
 * Заявка на сделку.
 *
 * На пилоте сделку заводит оператор: он проверяет объект по реестру и обе
 * стороны **до** того, как система запросит деньги. Экран это и говорит —
 * заявка не создаёт сделку, а начинает разговор. Роль выбирается один раз и
 * принадлежит сделке, а не кабинету.
 */
const ROLES = ['paying', 'receiving'] as const;

const FIELDS = ['cadastral', 'amount', 'counterparty', 'condition'] as const;

export default async function NewDealPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const role = query.role === 'receiving' ? 'receiving' : 'paying';
  const l = { dict: dictionaryOf(locale), locale };

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}`}>
          {t(l.dict, 'deal.backToList')}
        </a>
      </nav>

      <div className="pagehead">
        <h1>{t(l.dict, 'newDeal.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'newDeal.subtitle')}</p>
      </div>

      <section className="card" aria-labelledby="role">
        <h2 className="card__title" id="role">
          {t(l.dict, 'newDeal.role.question')}
        </h2>
        <p className="muted">{t(l.dict, 'newDeal.role.note')}</p>
        <div className="outcomes" style={{ marginBlockStart: 'var(--s-3)' }}>
          {ROLES.map((item) => (
            <a
              className="outcome"
              key={item}
              href={`/${locale}/deals/new?role=${item}`}
              aria-current={item === role ? 'true' : undefined}
              style={
                item === role
                  ? { borderColor: 'var(--c-accent)', background: 'var(--c-accent-soft)' }
                  : undefined
              }
            >
              <span className="outcome__title">{t(l.dict, `newDeal.role.${item}.title`)}</span>
              <span className="outcome__body">{t(l.dict, `newDeal.role.${item}.body`)}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="card" aria-labelledby="deal-form">
        <h2 className="card__title" id="deal-form">
          {t(l.dict, 'newDeal.form.title')}
        </h2>
        <div className="form-grid">
          {FIELDS.map((field) => (
            <div className="field" key={field}>
              <span className="field__label">{t(l.dict, `newDeal.field.${field}`)}</span>
              {/* Поле заполняет менеджер сделки: на пилоте сделку заводит
                  оператор, и форма показывает состав данных, а не собирает их. */}
              <span className="fld fld--readonly">{t(l.dict, 'newDeal.field.placeholder')}</span>
              <span className="field__hint">{t(l.dict, `newDeal.field.${field}.hint`)}</span>
            </div>
          ))}
        </div>

        <div className="card card--quiet" style={{ marginBlockStart: 'var(--s-4)' }}>
          <p className="muted">
            <StatusDot tone="warn" /> {t(l.dict, 'newDeal.warning')}
          </p>
        </div>

        <p className="actions" style={{ marginBlockStart: 'var(--s-4)' }}>
          <a className="btn" href={`/${locale}`}>
            {t(l.dict, 'newDeal.submit')}
          </a>
          <span className="faint">{t(l.dict, 'newDeal.submit.note')}</span>
        </p>
      </section>

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="deals.roleNote.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'deals.roleNote.body')}
        </p>
      </section>

      <SecurityBlock l={l} />
    </>
  );
}
