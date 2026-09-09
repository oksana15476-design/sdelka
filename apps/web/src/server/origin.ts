import { createHmac } from 'node:crypto';
import { type Fingerprint, fingerprint } from '@sdelka/auth';
import type { SignInOrigin } from '@sdelka/app';
import { headers } from 'next/headers';
import { AUTH_CODE_KEY_ENV } from './auth-config';
import { LOCALE_TAG, type Locale } from '@/i18n/locales';

/**
 * Откуда пришла попытка входа — **отпечатками, а не значениями**.
 *
 * `ACTORS.md` §4.1 A2 и инвариант 24: в журнал идут отпечатки устройства и
 * сети, а не сырые идентификаторы. Основание практическое: журнал входов не
 * редактируется (красная линия №11), а сетевой адрес — персональные данные;
 * попавший туда, он останется навсегда.
 *
 * ## Почему ключевое хеширование, а не просто хеш
 *
 * Пространство адресов IPv4 перебирается целиком за минуты, то есть обычный
 * `sha256(адрес)` восстанавливается словарём. Поэтому отпечаток — `HMAC` с
 * ключом из окружения, тем же приёмом, что и в `compliance/src/pii.ts`
 * («отпечаток, полученный снаружи с перцем из окружения»).
 *
 * ⚠ **Ключ взят тот же, что у вывода кода, с разделением назначений строкой
 * области.** Отдельная переменная была бы чище, но каждая новая обязательная
 * переменная — это ещё один способ не подняться в бою, и заводить её ради
 * второго назначения того же секрета я не вправе. Цена: утечка ключа кода
 * даёт и словарь отпечатков. Развилка вынесена владельцу —
 * `DECISIONS-REVIEW.md` §Z4 **[открыто]**.
 */

function peppered(scope: string, value: string): Fingerprint {
  const key = process.env[AUTH_CODE_KEY_ENV] ?? '';
  return fingerprint(createHmac('sha256', key).update(`${scope} ${value}`, 'utf8').digest('hex'));
}

/**
 * Сетевой адрес запроса.
 *
 * `x-forwarded-for` — первый адрес слева: его ставит ближайший к клиенту
 * доверенный посредник. Заголовок подделываем клиентом целиком, поэтому
 * отпечаток по нему — сигнал для расследования, а не доказательство; ничего,
 * кроме журнала, на нём не стоит.
 */
function networkOf(headerBag: Headers): string | null {
  const forwarded = headerBag.get('x-forwarded-for');
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (first.length > 0) return first;
  }
  const real = headerBag.get('x-real-ip');
  return real !== null && real.length > 0 ? real : null;
}

export async function signInOrigin(locale: Locale): Promise<SignInOrigin> {
  const bag = await headers();
  const agent = bag.get('user-agent');
  const network = networkOf(bag);
  return {
    device: agent === null || agent.length === 0 ? null : peppered('device', agent),
    network: network === null ? null : peppered('network', network),
    // Язык получателя тегом локали: перевод письма или сообщения делает канал.
    locale: LOCALE_TAG[locale],
  };
}
