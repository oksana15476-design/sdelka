import type { ReactNode } from 'react';
import { LOCALES } from '@/i18n/locales';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';

/**
 * Шапка кабинета. Разделов три, и ни один из них не называет роль: роль —
 * свойство сделки, а не место в навигации.
 */
const SECTIONS = [
  { key: 'nav.deals', href: '' },
  { key: 'nav.account', href: '/account' },
  { key: 'nav.requisites', href: '/requisites' },
] as const;

/**
 * Консоль — другое рабочее место, а не раздел кабинета: клиентская навигация в
 * ней не показывается вовсе, иначе оператор попадает в чужой счёт одним нажатием.
 */
const CONSOLE_SECTIONS = [{ key: 'nav.queue', href: '/ops' }] as const;

export function AppHeader({
  l,
  section = '',
  variant = 'client',
}: {
  readonly l: L10n;
  readonly section?: string;
  readonly variant?: 'client' | 'console';
}): ReactNode {
  const console = variant === 'console';
  return (
    <header className="appbar">
      <div className="appbar__inner">
        <a className="appbar__brand" href={console ? `/${l.locale}/ops` : `/${l.locale}`}>
          {t(l.dict, 'app.brand')}
          <small>{t(l.dict, console ? 'app.console' : 'app.tagline')}</small>
        </a>
        <nav className="nav" aria-label={t(l.dict, 'nav.primary')}>
          {(console ? CONSOLE_SECTIONS : SECTIONS).map((item) => (
            <a
              className="nav__link"
              key={item.key}
              href={`/${l.locale}${item.href}`}
              aria-current={item.href === section ? 'page' : undefined}
            >
              {t(l.dict, item.key)}
            </a>
          ))}
        </nav>
        <div className="langs">
          <span className="visually-hidden" id="lang-label">
            {t(l.dict, 'app.language')}
          </span>
          {LOCALES.map((locale) => (
            <a
              className="langs__item"
              key={locale}
              href={`/${locale}`}
              hrefLang={locale}
              aria-current={locale === l.locale ? 'true' : undefined}
            >
              {t(l.dict, `app.language.${locale}`)}
            </a>
          ))}
        </div>
      </div>
    </header>
  );
}
