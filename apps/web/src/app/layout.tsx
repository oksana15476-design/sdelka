import type { ReactNode } from 'react';

export const metadata = { title: 'Сделка' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
