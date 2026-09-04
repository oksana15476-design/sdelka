import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config';
// @ts-expect-error — общий модуль скриптов на JS: у него нет и не должно быть
// типов, потому что его вторая половина (`guard-mutation.mjs`) запускается
// голым node, без сборщика.
import { MUTATION_ENV, mutateSource, parseTarget } from './guard-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

/**
 * Конфигурация мутационного прогона: `pnpm --filter @sdelka/e2e mutation`.
 *
 * Обычный `pnpm test` её не читает — там своя, без подмены. Разные файлы, а не
 * флаг в одном: конфигурация прогона, который намеренно ломает домен, не должна
 * лежать на пути обычного запуска тестов, где её однажды включат случайно.
 *
 * ## Почему подмена — `transform`, а не резолвер
 *
 * Резолверная подмена (она осталась в `../vitest.config.ts` и с этого дня
 * никем не используется) заменяла **экспорт** модуля guard'ов. Это работало
 * ровно для одного из трёх перечней домена и по случайности: таблицу guard'ов
 * транша читает другой модуль. Таблица сделки (`DEAL_GUARDS`) не
 * экспортируется вовсе, а `reduceWithdrawal` зовёт `evaluateWithdrawalGuard`
 * из своего же модуля — подменённый экспорт на них не влияет никак, и прогон
 * остался бы зелёным при «сломанном» guard'е. Мутация, которая ничего не
 * мутирует, хуже отсутствующей: она отчитывается об успехе.
 *
 * `transform` правит текст модуля до компиляции — там, где реализация
 * объявлена. Кто её читает, значения больше не имеет. На диск не пишется
 * ничего; скрипт сверяет отпечаток дерева до и после прогона.
 */
function guardMutation(): Plugin {
  return {
    name: 'sdelka:guard-mutation-source',
    enforce: 'pre',
    transform(code: string, id: string) {
      const spec = process.env[MUTATION_ENV];
      if (spec === undefined || spec === '') return null;
      const target = parseTarget(spec);
      if (id.split('?')[0] !== target.file) return null;
      // Ошибка подмены обязана быть слышна: она заканчивается словом
      // `sdelka.mutation.…`, по которому скрипт отличает сломанный прогон от
      // убитого guard'а. Без этого различения сломанная подмена читается как
      // «правило проверяется».
      return { code: mutateSource(code, target.guard, target.file), map: null };
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    root: PACKAGE_ROOT,
    plugins: [guardMutation()],
  }),
);
