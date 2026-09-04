import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate } from '@/i18n/format';
import { viewerTimeZone } from '@/fixtures/store';
import { getArchive } from '@/fixtures/screens';
import { Amount, Badge, EmptyState, ListRow, SecurityBlock } from '@/ui/primitives';

/**
 * Архив закрытых сделок. У несостоявшейся сделки суммы к получению нет вовсе —
 * ни нулём, ни прочерком: строка говорит, что произошло, а не показывает ноль
 * там, где числа не существует.
 */
export default async function ArchivePage({
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
  const items = await getArchive();
  const viewerZone = viewerTimeZone();

  return (
    <>
      <nav className="breadcrumb" aria-label={t(l.dict, 'nav.breadcrumb')}>
        <a className="chipbtn" href={`/${locale}/account`}>
          {t(l.dict, 'withdraw.back')}
        </a>
      </nav>

      <div className="pagehead">
        <h1>{t(l.dict, 'archive.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'archive.subtitle')}</p>
      </div>

      {screenState === 'empty' || items.length === 0 ? (
        <EmptyState l={l} titleKey="archive.empty.title" bodyKey="archive.empty.body" />
      ) : (
        <section className="card">
          <h2 className="card__title">{t(l.dict, 'archive.list.title')}</h2>
          <div className="list">
            {items.map((item) => (
              <ListRow
                key={item.id}
                label={
                  <a href={`/${locale}/deals/${item.id}`}>{item.address}</a>
                }
                meta={`${item.ref} · ${formatDate(locale, item.at, viewerZone)}`}
                value={
                  <>
                    {item.amount === null ? (
                      <Badge tone="refund" label={t(l.dict, 'archive.outcome.notSettled')} />
                    ) : (
                      <Amount l={l} value={item.amount} labelKey="archive.outcome.settled" />
                    )}
                    <a className="chipbtn" href={`/${locale}/documents`}>
                      {t(l.dict, 'archive.documents')}
                    </a>
                  </>
                }
              />
            ))}
          </div>
        </section>
      )}

      <SecurityBlock l={l} />
    </>
  );
}
