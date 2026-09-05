import type { ReactNode } from 'react';
import { type Locale, localePath } from '@/i18n/locales';
import { t } from '@/i18n/translate';
import { Mark } from './chrome';
import { StatusDot } from './primitives';
import type { L10n } from './l10n';

/**
 * Каркас публичных страниц: лендинг, страница второй стороны, партнёрская.
 *
 * ## Почему это не `AppShell`
 *
 * Каркас кабинета несёт навигацию по разделам, карточку человека и ссылки в
 * консоль и кабинет владельца. На публичной странице любая из них — нарушение
 * критерия приёмки ПЛ9 (`LANDING.md` §9): аутентификации в продукте нет вовсе
 * (`ACTORS.md` §0 п. 10), и публичная ссылка в кабинет превратила бы известный
 * блокер в эксплуатируемый. Поэтому здесь нет ни одной ссылки внутрь продукта
 * и нет кнопки «войти»: её появление — часть работы над аутентификацией, а не
 * над лендингом.
 *
 * ## Порядок языков
 *
 * Грузинский стоит **первым**, а не третьим, как в кабинете. Требование закона
 * о государственном языке сформулировано для материала, где два языка стоят
 * рядом, и применимо ли оно к сайту с переключателем — вопрос юристу
 * (`LANDING.md` §5.2, **[открыто]**). До ответа берётся строгое прочтение:
 * грузинская версия существует, стоит первой и набрана тем же кеглем, что
 * остальные две. Кегль одинаковый по построению — все три ссылки одного класса.
 */
const PUBLIC_LOCALES: readonly Locale[] = Object.freeze(['ka', 'ru', 'en']);

/**
 * Три публичные страницы. Списка разделов у публичного сайта нет — есть две
 * ссылки в подвале: страница для второй стороны (её пересылают) и партнёрская.
 * Ни одна не ведёт внутрь продукта.
 */
const PUBLIC_PAGES = [
  { key: 'landing.hero.forward', href: '/landing/recipient' },
  { key: 'landing.foot.partner', href: '/landing/partners' },
] as const;

/**
 * Постоянный блок безопасности публичных страниц.
 *
 * Текст **тот же самый**, что в кабинете и в письмах: ключи `security.rule.*`
 * переиспользуются, а не копируются в `landing.*`. Два текста об одном правиле
 * расходятся молча (`LANDING.md` §8.11).
 *
 * От кабинетного блока отличается ровно одним: здесь нет кнопки «сообщить о
 * контакте». Она ведёт на экран кабинета, а публичная страница в кабинет не
 * ссылается.
 */
function PublicSecurity({ l }: { readonly l: L10n }): ReactNode {
  const rules = [
    'security.rule.channels',
    'security.rule.onlyHere',
    'security.rule.neverAskTransfer',
    'security.rule.neverAskChange',
  ];
  return (
    <section aria-labelledby="security-public" className="security">
      <h2 className="security__title" id="security-public">
        {t(l.dict, 'security.title')}
      </h2>
      <div className="security__list">
        {rules.map((key) => (
          <p className="security__item" key={key}>
            <StatusDot tone="info" />
            <span>{t(l.dict, key)}</span>
          </p>
        ))}
      </div>
    </section>
  );
}

export function PublicShell({
  l,
  path,
  children,
}: {
  readonly l: L10n;
  readonly path: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="frame">
      <div className="pub">
        <header className="pub__top">
          <a className="pub__brand" href={`/${l.locale}/landing`}>
            <Mark />
            <span>
              {t(l.dict, 'app.brand')}
              <small>{t(l.dict, 'app.tagline')}</small>
            </span>
          </a>
          <div aria-labelledby="lang-label" className="langs" role="group">
            <span className="visually-hidden" id="lang-label">
              {t(l.dict, 'app.language')}
            </span>
            {PUBLIC_LOCALES.map((locale) => (
              <a
                aria-current={locale === l.locale ? 'true' : undefined}
                className="langs__item"
                href={localePath(path, locale)}
                hrefLang={locale}
                key={locale}
              >
                {t(l.dict, `app.language.${locale}`)}
              </a>
            ))}
          </div>
        </header>

        <main className="main" id="content">
          <div className="sheet">{children}</div>
        </main>

        <footer className="pub__foot">
          <div className="sheet">
            <PublicSecurity l={l} />
            {/* Текущая страница остаётся в списке, но помечена: ссылка на саму
                себя без пометки — два «где я» в одном блоке, то есть ни одного. */}
            <nav aria-label={t(l.dict, 'nav.primary')} className="pub__links">
              {PUBLIC_PAGES.map((page) => (
                <a
                  aria-current={path === `/${l.locale}${page.href}` ? 'page' : undefined}
                  className="chipbtn"
                  href={`/${l.locale}${page.href}`}
                  key={page.href}
                >
                  {t(l.dict, page.key)}
                </a>
              ))}
            </nav>
            <p className="faint">{t(l.dict, 'landing.foot.note')}</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
