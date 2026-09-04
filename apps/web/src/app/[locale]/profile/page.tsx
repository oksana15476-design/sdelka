import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { formatDate, formatDateTime } from '@/i18n/format';
import { viewerTimeZone } from '@/fixtures/store';
import { getProfile } from '@/fixtures/screens';
import { Badge, Eyebrow, ListRow, Row, SecurityBlock } from '@/ui/primitives';

/**
 * Профиль и проверка личности. Проверка проходится один раз и годится для всех
 * сделок в любой роли: кабинет один, роль — свойство сделки.
 *
 * Здесь же права субъекта данных: выгрузка и запрос на удаление. Данные по
 * закрытым сделкам хранятся установленный срок — это сказано до запроса, а не
 * после отказа.
 */
export default async function ProfilePage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const l = { dict: dictionaryOf(locale), locale };
  const profile = await getProfile();
  const viewerZone = viewerTimeZone();

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'profile.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'profile.subtitle')}</p>
      </div>

      <section className="card" aria-labelledby="identity">
        <div className="state-card__top">
          <h2 className="card__title" id="identity">
            {profile.name}
          </h2>
          <Badge tone="ok" label={t(l.dict, 'profile.verified')} />
        </div>
        <div className="rows">
          <Row l={l} labelKey="profile.email">
            <span className="mono">{profile.email}</span>
          </Row>
          <Row l={l} labelKey="profile.document">
            <span className="mono">
              {profile.documentCountry} {profile.documentMasked}
            </span>
          </Row>
          <Row l={l} labelKey="profile.residency">
            <span className="mono">{profile.documentCountry}</span>
          </Row>
          <Row l={l} labelKey="profile.source">
            <span>{formatDate(locale, profile.sourceAcceptedAt, viewerZone)}</span>
          </Row>
          <Row l={l} labelKey="profile.review">
            <span>{formatDate(locale, profile.reviewAt, viewerZone)}</span>
          </Row>
        </div>
        <p className="muted" style={{ marginBlockStart: 'var(--s-3)' }}>
          {t(l.dict, 'profile.review.note')}
        </p>
      </section>

      <section className="card" aria-labelledby="sessions">
        <h2 className="card__title" id="sessions">
          {t(l.dict, 'profile.sessions.title')}
        </h2>
        <p className="muted">{t(l.dict, 'profile.sessions.body')}</p>
        <div className="list" style={{ marginBlockStart: 'var(--s-3)' }}>
          {profile.sessions.map((session) => (
            <ListRow
              key={session.id}
              label={`${session.device} · ${session.place}`}
              meta={formatDateTime(locale, session.at, viewerZone)}
              value={
                session.current ? (
                  <Badge tone="ok" label={t(l.dict, 'profile.sessions.current')} />
                ) : (
                  <a className="chipbtn" href={`/${locale}/security`}>
                    {t(l.dict, 'profile.sessions.close')}
                  </a>
                )
              }
            />
          ))}
        </div>
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn btn--secondary" href={`/${locale}/security`}>
            {t(l.dict, 'profile.sessions.revokeAll')}
          </a>
        </p>
      </section>

      <section className="card card--quiet">
        <Eyebrow l={l} labelKey="profile.data.title" />
        <p className="muted" style={{ marginBlockStart: 'var(--s-2)' }}>
          {t(l.dict, 'profile.data.body')}
        </p>
        <p className="actions" style={{ marginBlockStart: 'var(--s-3)' }}>
          <a className="btn btn--secondary" href={`/${locale}/security`}>
            {t(l.dict, 'profile.data.export')}
          </a>
          <a className="btn btn--ghost" href={`/${locale}/security`}>
            {t(l.dict, 'profile.data.delete')}
          </a>
        </p>
      </section>

      <SecurityBlock l={l} />
    </>
  );
}
