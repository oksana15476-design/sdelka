'use server';

import { requestSignInCode, signOut, submitSignInCode } from '@sdelka/app';
import { redirect } from 'next/navigation';
import { signInRuntime } from '@/server/auth-runtime';
import { signInOrigin } from '@/server/origin';
import {
  clearSessionCookie,
  sessionCookieValue,
  writeSessionCookie,
} from '@/server/session-cookie';
import { DEFAULT_LOCALE, type Locale, isLocale } from '@/i18n/locales';

/**
 * Транспорт входа: **форма → вызов, результат → адрес**.
 *
 * Здесь нет ни одного решения. Ни срока, ни числа попыток, ни ответа на вопрос
 * «пускать ли» — всё это в `@sdelka/app` (`sign-in.ts`), и попасть сюда оно
 * может только одним способом: если кто-то решит, что «на транспорте виднее».
 * Ровно поэтому в файле нет ни `if` по причине отказа, ни разбора ключа: наверх
 * приходит одна причина на все отказы, и она же уходит в адрес.
 *
 * Состояние шага живёт **в адресе**, а не в скрытом поле и не в памяти:
 * `?ref=` — ссылка на вызов, `?e=1` — «не сошлось». Форма работает без
 * JavaScript (`ui/form.tsx`, контракт п.1), а перезагруженная страница остаётся
 * тем же шагом, а не сбрасывается в начало.
 */

function localeOf(value: FormDataEntryValue | null): Locale {
  const raw = typeof value === 'string' ? value : '';
  return isLocale(raw) ? raw : DEFAULT_LOCALE;
}

function textOf(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Шаг первый: «пришлите код».
 *
 * Ответ один на оба исхода — известная запись и неизвестная: адрес после
 * отправки выглядит одинаково, потому что различать их снаружи и значит
 * перечислять учётные записи.
 */
export async function requestCodeAction(form: FormData): Promise<void> {
  const locale = localeOf(form.get('locale'));
  const runtime = signInRuntime();
  const result = await requestSignInCode(runtime, {
    accountKey: textOf(form.get('account')).trim(),
    origin: await signInOrigin(locale),
  });
  // `redirect` бросает управляющее исключение — он обязан стоять вне `try`.
  redirect(
    result.ok
      ? `/${locale}/login?ref=${encodeURIComponent(result.value.challengeId)}`
      : `/${locale}/login?e=1`,
  );
}

/** Шаг второй: «вот код». Успех — кука и кабинет; отказ — тот же экран с меткой. */
export async function submitCodeAction(form: FormData): Promise<void> {
  const locale = localeOf(form.get('locale'));
  const reference = textOf(form.get('ref'));
  const runtime = signInRuntime();
  const result = await submitSignInCode(runtime, {
    challengeId: reference,
    code: textOf(form.get('code')),
    origin: await signInOrigin(locale),
  });
  if (result.ok) {
    await writeSessionCookie(result.value);
    redirect(`/${locale}`);
  }
  redirect(`/${locale}/login?ref=${encodeURIComponent(reference)}&e=1`);
}

/**
 * Выход.
 *
 * Кука снимается **после** отзыва, а не вместо него: снятая кука без записи в
 * журнале — это «выход», после которого прежний идентификатор продолжает
 * открывать доступ у всякого, кто его сохранил.
 */
export async function signOutAction(form: FormData): Promise<void> {
  const locale = localeOf(form.get('locale'));
  const current = await sessionCookieValue();
  if (current !== null) {
    await signOut(signInRuntime(), { sessionId: current });
  }
  await clearSessionCookie();
  redirect(`/${locale}/login`);
}
