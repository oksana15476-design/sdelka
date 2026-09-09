import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Корень монорепо. Нужен трассировке файлов: в pnpm-репозитории зависимости
 * лежат не в `apps/web/node_modules`, а в общем хранилище `node_modules/.pnpm`
 * на уровне корня, и без явного корня трассировка обрывается на символьной
 * ссылке — сборка проходит, а в `standalone` не попадает половина модулей.
 * Отказ при этом не на сборке, а на первом запросе в контейнере.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: [
    '@sdelka/app',
    '@sdelka/audit',
    '@sdelka/auth',
    '@sdelka/compliance',
    '@sdelka/db',
    '@sdelka/domain',
    '@sdelka/intake',
    '@sdelka/ledger',
    '@sdelka/money',
  ],

  /**
   * `standalone` — самодостаточный вывод: `server.js` плюс только те модули,
   * которые действительно достижимы из кода. Без него образ обязан нести весь
   * `node_modules` монорепо, включая инструменты сборки и стенды.
   *
   * На `next start` это не влияет: Next предупреждает, что при `standalone`
   * правильнее запускать `node server.js`, но продолжает работать — обход
   * интерфейса (`scripts/verify-ui.mjs`) поднимает сервер прежним способом.
   */
  output: 'standalone',
  outputFileTracingRoot: REPO_ROOT,
};
