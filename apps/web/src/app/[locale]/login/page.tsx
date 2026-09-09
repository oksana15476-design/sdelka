import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { IDENTITY_CODE_POLICY } from '@sdelka/auth';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, plural, t } from '@/i18n/translate';
import { ErrorSummary, FormField, SubmitButton } from '@/ui/form';
import { requestCodeAction, submitCodeAction } from './actions';

/**
 * Экран входа: два шага в одном адресе.
 *
 * Шаг виден по адресу, а не по состоянию в памяти: без `ref` спрашивается ключ
 * учётной записи, с `ref` — код. Перезагруженная страница остаётся тем же
 * шагом, а не сбрасывается в начало, и ссылку можно открыть в другой вкладке —
 * второй вызов при этом не выдаётся.
 *
 * ## Экран ничего не решает
 *
 * Ни одного условия о входе здесь нет. Отказ приходит одной меткой `e=1`, и
 * другой у него не бывает: «такой записи нет» и «код не подошёл» снаружи
 * обязаны быть неразличимы, иначе форма входа работает перечислителем учётных
 * записей. Настоящая причина уходит в журнал входов (`app/src/sign-in.ts`).
 *
 * ## Без JavaScript
 *
 * Обе формы — обычные формы с серверным действием: они отправляются и без
 * скрипта (`ui/form.tsx`, контракт п.1). Экран, на который нельзя войти при
 * неприехавшем скрипте, — это экран, на который иногда нельзя войти.
 */
export const dynamic = 'force-dynamic';

const CODE_TTL_MINUTES = Math.round(IDENTITY_CODE_POLICY.ttl / 60_000);

export default async function LoginPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const query = await searchParams;
  const reference = typeof query.ref === 'string' ? query.ref : null;
  const failed = query.e === '1';
  const l = { dict: dictionaryOf(locale), locale };
  const problems = failed
    ? [{ field: reference === null ? 'account' : 'code', messageKey: 'signIn.error.body' }]
    : [];

  return (
    <>
      <div className="pagehead">
        <h1>{t(l.dict, 'signIn.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'signIn.subtitle')}</p>
      </div>

      <ErrorSummary l={l} problems={problems} titleKey="signIn.error.title" />

      {reference === null ? (
        <section className="card" aria-labelledby="signin-account">
          <h2 className="card__title" id="signin-account">
            {t(l.dict, 'signIn.account.label')}
          </h2>
          <form action={requestCodeAction}>
            <input name="locale" type="hidden" value={locale} />
            <FormField
              hintKey="signIn.account.hint"
              l={l}
              labelKey="signIn.account.label"
              name="account"
            >
              <input
                aria-describedby="account-hint"
                autoComplete="username"
                className="fld"
                id="account"
                name="account"
                type="text"
              />
            </FormField>
            <SubmitButton l={l} labelKey="signIn.account.cta" name="step" value="request" />
          </form>
        </section>
      ) : (
        <section className="card" aria-labelledby="signin-code">
          <h2 className="card__title" id="signin-code">
            {t(l.dict, 'signIn.sent.title')}
          </h2>
          <p className="muted">{t(l.dict, 'signIn.sent.body')}</p>
          {/* Срок берётся из политики, а не вписан в текст словом: разойтись им
              негде — число приходит из того же значения, что и сам срок. */}
          <p className="muted">
            {plural(l.dict, l.locale, 'signIn.code.ttl', CODE_TTL_MINUTES)}
          </p>
          <form action={submitCodeAction}>
            <input name="locale" type="hidden" value={locale} />
            <input name="ref" type="hidden" value={reference} />
            <FormField hintKey="signIn.code.hint" l={l} labelKey="signIn.code.label" name="code">
              <input
                aria-describedby="code-hint"
                autoComplete="one-time-code"
                className="fld"
                id="code"
                inputMode="numeric"
                name="code"
                type="text"
              />
            </FormField>
            <SubmitButton l={l} labelKey="signIn.code.cta" name="step" value="submit" />
          </form>
          <p className="muted">
            <a href={`/${locale}/login`}>{t(l.dict, 'signIn.code.again')}</a>
          </p>
        </section>
      )}
    </>
  );
}
