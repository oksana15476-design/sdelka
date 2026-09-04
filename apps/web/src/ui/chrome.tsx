import type { ReactNode } from 'react';
import { LOCALES } from '@/i18n/locales';
import { t } from '@/i18n/translate';
import type { L10n } from './l10n';

/**
 * Знак «Сдвиг»: два круга, смещённых по диагонали, — одно состояние переходит
 * в другое (брендбук §02). Передний круг всегда правый нижний: направление
 * перехода не меняется никогда, поэтому геометрия задана стилем, а не пропом.
 */
export function Mark({ size = 'md' }: { readonly size?: 'md' | 'lg' }): ReactNode {
  return (
    <span className={`mk${size === 'lg' ? ' mk--lg' : ''}`} aria-hidden="true">
      <i />
      <i />
    </span>
  );
}

/**
 * Разделы кабинета. Ни один не называет роль: роль — свойство сделки, а не
 * место в навигации (`CABINETS.md` §0.4).
 */
const SECTIONS = [
  { key: 'nav.deals', href: '' },
  { key: 'nav.account', href: '/account' },
  { key: 'nav.requisites', href: '/requisites' },
  { key: 'nav.documents', href: '/documents' },
  { key: 'nav.notifications', href: '/notifications' },
  { key: 'nav.help', href: '/security' },
  { key: 'nav.profile', href: '/profile' },
] as const;

/**
 * Консоль — другое рабочее место, а не раздел кабинета: клиентская навигация в
 * ней не показывается вовсе, иначе оператор попадает в чужой счёт одним нажатием.
 *
 * Разделов **два, и оба не про сущности**. Прежде их было четыре — очередь,
 * решение о выплате, сверка, заморозка, — то есть три из четырёх были входом в
 * одну конкретную сделку. Оператор в такой панели выбирает не работу, а экран, и
 * очередь перестаёт быть очередью (`CABINETS.md` §5.1).
 *
 * Осталось ровно то, ради чего в консоль заходят: **очередь работы** — всё, что
 * требует человека, и **дежурный дашборд** — пять метрик, на которые смотрят
 * каждое утро (§5.4). Разбор выплаты, расхождения и приостановки — это карточки
 * задач, и достижимы они только из очереди.
 */
const CONSOLE_SECTIONS = [
  { key: 'nav.queue', href: '/ops' },
  { key: 'nav.duty', href: '/ops/duty' },
] as const;

/**
 * Кабинет владельца — третье рабочее место, и оно **не пересекается** с
 * консолью ни одним разделом (E16-1). Ссылки на очередь здесь нет намеренно:
 * владелец не утверждает выплату, а «расширенные права» — это ровно тот способ,
 * которым разделение ролей теряется. Обратной ссылки из консоли сюда тоже нет:
 * операционная роль не видит деньги компании.
 */
const OWNER_SECTIONS = [
  { key: 'nav.owner.summary', href: '/owner' },
  { key: 'nav.owner.deals', href: '/owner/deals' },
  { key: 'nav.owner.tariff', href: '/owner/tariff' },
] as const;

function isCurrent(path: string, locale: string, href: string): boolean {
  const own = `/${locale}${href}`;
  if (href === '') return path === `/${locale}` || path === `/${locale}/`;
  return path === own || path.startsWith(`${own}/`);
}

/**
 * Текущий раздел — **один**, самый длинный из подошедших.
 *
 * Разделы вкладываются друг в друга: `/ops` и `/ops/duty` подходят к адресу
 * дежурного дашборда оба, и без выбора самого длинного `aria-current="page"`
 * оказывается на двух ссылках сразу. Для скринридера это два «текущих» пункта в
 * одном списке, то есть ни одного.
 */
function currentHref(
  sections: readonly { readonly href: string }[],
  path: string,
  locale: string,
): string | null {
  let best: string | null = null;
  for (const section of sections) {
    if (!isCurrent(path, locale, section.href)) continue;
    if (best === null || section.href.length > best.length) best = section.href;
  }
  return best;
}

/**
 * Каркас кабинета: боковая навигация 248 px и содержимое до 880 px на широком
 * экране, тонкая шапка с бургером и выдвижная панель 274 px ниже 1024 px
 * (`IMPLEMENTATION.md` §5).
 *
 * Панель открывается ссылкой на якорь, а не клиентским кодом: одна и та же
 * разметка работает и как боковая колонка, и как выдвижная панель, а закрытая
 * панель убрана из фокуса (`visibility: hidden`), а не только из вида.
 */
export interface ViewerCard {
  readonly name: string;
  readonly email: string;
  readonly initials: string;
}

export function AppShell({
  l,
  path,
  viewer,
  variant = 'client',
  unread = 0,
  children,
}: {
  readonly l: L10n;
  readonly path: string;
  readonly viewer: ViewerCard;
  readonly variant?: 'client' | 'console' | 'owner';
  readonly unread?: number;
  readonly children: ReactNode;
}): ReactNode {
  const console = variant === 'console';
  const owner = variant === 'owner';
  const home = console ? `/${l.locale}/ops` : owner ? `/${l.locale}/owner` : `/${l.locale}`;
  const sections: readonly { readonly key: string; readonly href: string }[] = console
    ? CONSOLE_SECTIONS
    : owner
      ? OWNER_SECTIONS
      : SECTIONS;
  const current = currentHref(sections, path, l.locale);
  const wide = console || owner;
  return (
    <div className="frame">
      <div className="shell">
        <nav className="side" id="menu" aria-label={t(l.dict, 'nav.primary')}>
          <a className="side__brand" href={home}>
            <Mark />
            <span>
              {t(l.dict, 'app.brand')}
              <small>{t(l.dict, console ? 'app.console' : owner ? 'app.owner' : 'app.tagline')}</small>
            </span>
          </a>

          <div className="side__nav">
            {sections.map((item) => (
              <a
                className="nav__link"
                key={item.key}
                href={`/${l.locale}${item.href}`}
                aria-current={item.href === current ? 'page' : undefined}
              >
                <span>{t(l.dict, item.key)}</span>
                {item.key === 'nav.notifications' && unread > 0 ? (
                  <span className="nav__count">{unread}</span>
                ) : null}
              </a>
            ))}
          </div>

          <div className="side__foot">
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
            {console || owner ? (
              <a className="nav__link" href={`/${l.locale}`}>
                <span>{t(l.dict, 'nav.deals')}</span>
              </a>
            ) : (
              <>
                <a className="person" href={`/${l.locale}/profile`}>
                  <span className="person__avatar" aria-hidden="true">
                    {viewer.initials}
                  </span>
                  <span className="person__body">
                    <span className="person__name">{viewer.name}</span>
                    <span className="faint">{viewer.email}</span>
                  </span>
                </a>
                <a className="nav__link" href={`/${l.locale}/ops`}>
                  <span>{t(l.dict, 'nav.console')}</span>
                </a>
                {/* Пока сессий нет, оба рабочих места достижимы по адресу —
                    ссылка это только признаёт. Правом она не является: право
                    проверяет сервер, которого ещё нет (`owner-role.ts`). */}
                <a className="nav__link" href={`/${l.locale}/owner`}>
                  <span>{t(l.dict, 'nav.owner')}</span>
                </a>
              </>
            )}
          </div>
        </nav>

        {/* Затемнение по фону: закрывает панель и само является целью касания. */}
        <a className="scrim" href="#content">
          <span className="visually-hidden">{t(l.dict, 'nav.close')}</span>
        </a>

        <div className="column">
          <header className="topbar">
            <a className="burger" href="#menu">
              <i />
              <i />
              <i />
              <span className="visually-hidden">{t(l.dict, 'nav.open')}</span>
            </a>
            <a className="topbar__brand" href={home}>
              <Mark />
              {t(l.dict, 'app.brand')}
            </a>
          </header>
          <main className="main" id="content">
            <div className={wide ? 'sheet sheet--wide' : 'sheet'}>{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
