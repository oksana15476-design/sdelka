import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isLocale } from '@/i18n/locales';
import { dictionaryOf, t } from '@/i18n/translate';
import { SubmitButton } from '@/ui/form';
import { signOutAction } from '../login/actions';

/**
 * Выход — **отдельный шаг с подтверждением, а не ссылка**.
 *
 * Ссылка `GET /logout` выглядит удобнее ровно до того дня, когда чужая страница
 * покажет её картинкой: браузер сходит по адресу сам, и человека выкинет из
 * кабинета посреди работы. Выход поэтому идёт формой (`POST`), и кука сессии
 * при межсайтовой отправке не уходит вовсе (`sameSite: 'strict'`).
 *
 * Экран ничего не решает: отзыв делает `signOut` (`app/src/sign-in.ts`), и он
 * пишет запись в журнал до того, как снимается кука.
 */
export const dynamic = 'force-dynamic';

export default async function LogoutPage({
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
        <h1>{t(l.dict, 'signOut.title')}</h1>
        <p className="pagehead__note">{t(l.dict, 'signOut.body')}</p>
      </div>
      <section className="card">
        <form action={signOutAction}>
          <input name="locale" type="hidden" value={locale} />
          <SubmitButton l={l} labelKey="signOut.cta" name="step" value="sign-out" />
        </form>
      </section>
    </>
  );
}
