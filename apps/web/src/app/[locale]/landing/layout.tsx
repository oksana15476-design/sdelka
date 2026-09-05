import type { ReactNode } from 'react';
import '@/styles/landing.css';

/**
 * Каркас публичных страниц подключает только стили: сама оболочка выбирается
 * выше, в `app/[locale]/layout.tsx`, потому что заголовок `x-sdelka-path`
 * доходит до корневого макета, а сегмент маршрута — нет.
 *
 * Стили публичного сайта не едут в кабинет: они нужны трём страницам из
 * двадцати шести, и глобальный импорт стоил бы каждому экрану кабинета лишних
 * правил, которые он никогда не применит.
 */
export default function PublicLayout({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return children;
}
