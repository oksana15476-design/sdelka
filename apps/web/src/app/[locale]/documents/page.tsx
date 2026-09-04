import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate } from '@/i18n/format';
import { viewerTimeZone } from '@/fixtures/store';
import { getDocuments } from '@/fixtures/screens';
import { EmptyState, Eyebrow, ListRow, SecurityBlock } from '@/ui/primitives';

/**
 * Экран документов `B-06`.
 *
 * Документ, которого ещё нет, показан строкой с причиной, а не спрятан: пустое
 * место в списке читается как потеря. Каждый просмотр помечается водяным знаком
 * и попадает в журнал — об этом сказано до открытия, а не после.
 */
export default async function DocumentsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const screenState = typeof query.state === 'string' ? query.state : 'ready';
  const l = { dict: dictionaryOf(locale), locale };
  const documents = await getDocuments();
  const viewerZone = viewerTimeZone();

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'documents.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'documents.subtitle')}</p>
      </div>

      {screenState === 'empty' ? (
        <EmptyState l={l} titleKey="documents.empty.title" bodyKey="documents.empty.body" />
      ) : (
        <section className="card">
          <h2 className="card__title">{t(l.dict, 'documents.list.title')}</h2>
          <div className="list">
            {documents.map((document) => (
              <ListRow
                key={document.id}
                tone={document.available ? 'plain' : 'quiet'}
                label={t(l.dict, `documents.kind.${document.kind}`)}
                meta={
                  document.available
                    ? `${document.no ?? document.dealRef} · ${document.at === null ? '' : formatDate(locale, document.at, viewerZone)}`
                    : t(l.dict, 'documents.notYet')
                }
                value={
                  document.available ? (
                    <a className="chipbtn" href={`/${locale}/documents`}>
                      {t(l.dict, 'documents.open')}
                    </a>
                  ) : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="documents.watermark.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'documents.watermark.body')}
        </p>
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'documents.denied')}
        </p>
      </section>

      <SecurityBlock l={l} />
    </>
  );
}
