import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
// @ts-expect-error — общий модуль скриптов на JS: у него нет и не должно быть
// типов, потому что его вторая половина (`intake-mutation.mjs`) запускается
// голым node, без сборщика.
import { APPLIED_MARK, MUTATION_ENV, findMutant, mutateSource, targetFile } from './intake-mutants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

/**
 * Конфигурация мутационного прогона приёма: `pnpm --filter @sdelka/intake mutation`.
 *
 * Обычный `pnpm test` её не читает — он идёт по умолчанию, без подмены. Разные
 * файлы, а не флаг в одном: конфигурация прогона, который намеренно ломает
 * пакет, не должна лежать на пути обычного запуска тестов.
 *
 * Подмена живёт в `transform` и существует только в памяти процесса. Ни один
 * файл не меняется — ни на время прогона, ни на секунду; поэтому прерывание
 * прогона не оставляет репозиторий с испорченным исходником, и в `src` можно
 * работать параллельно. Скрипт сверяет отпечаток дерева до и после.
 *
 * Метка `sdelka.mutation.applied:` в потоке ошибок — не отладка. Без неё
 * «мутант выжил» и «мутант не был подставлен, потому что модуль никем не
 * импортирован» неразличимы, а второе выглядит как первое и читается как
 * «тестов не хватает» вместо «прогон сломан».
 */
function intakeMutation(): Plugin {
  return {
    name: 'sdelka:intake-mutation-source',
    enforce: 'pre',
    transform(code: string, id: string) {
      const spec = process.env[MUTATION_ENV];
      if (spec === undefined || spec === '') return null;
      const mutant = findMutant(spec);
      if (id.split('?')[0] !== targetFile(mutant)) return null;
      const mutated = mutateSource(code, mutant);
      // Два канала для одной метки, потому что запусков два: отдельным процессом
      // (`--only`, отладка) метку видно только в потоке, а внутри общего процесса
      // прогона поток тестов заглушен — там метку забирает скрипт прямо из
      // `globalThis`. Оба канала пишут одно и то же и существуют затем, чтобы
      // «мутант выжил» никогда не оказалось «мутация не дошла».
      const applied = ((globalThis as Record<string, unknown>).__sdelkaMutationApplied ??=
        new Set<string>()) as Set<string>;
      applied.add(mutant.id);
      process.stderr.write(`${APPLIED_MARK}${mutant.id}\n`);
      return { code: mutated, map: null };
    },
  };
}

export default defineConfig({
  root: PACKAGE_ROOT,
  plugins: [intakeMutation()],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
