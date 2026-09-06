import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
// @ts-expect-error — общий модуль скриптов на JS: у него нет и не должно быть
// типов, потому что его вторая половина (`ledger-mutation.mjs`) запускается
// голым node, без сборщика.
import {
  APPLIED_MARK,
  MUTATION_ENV,
  findMutant,
  mutateSource,
  targetFile,
} from './ledger-mutants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');

/**
 * Конфигурация мутационного прогона учёта:
 * `pnpm --filter @sdelka/ledger mutation`.
 *
 * Обычный `pnpm test` её не читает — он идёт по умолчанию, без подмены. Разные
 * файлы, а не флаг в одном: конфигурация прогона, который намеренно ломает
 * пакет, не должна лежать на пути обычного запуска тестов.
 *
 * Подмена живёт в `transform` и существует только в памяти процесса. Ни один
 * файл не меняется — ни на время прогона, ни на секунду; поэтому прерывание
 * прогона не оставляет репозиторий с испорченной политикой, и в `src` можно
 * работать параллельно. Скрипт сверяет отпечаток пакета до и после.
 *
 * Метка `sdelka.mutation.applied:` — не отладка. Без неё «мутант выжил» и
 * «мутант не был подставлен, потому что модуль никем не импортирован»
 * неразличимы, а второе выглядит как первое и читается как «тестов не хватает»
 * вместо «прогон сломан».
 */
function ledgerMutation(): Plugin {
  return {
    name: 'sdelka:ledger-mutation-source',
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
  plugins: [ledgerMutation()],
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * Для мутанта важен сам **факт** падения, а не полный список упавших тестов:
     * вердикт «убит» ставится по первому же. Без остановки каждый убитый мутант
     * стоил бы полного прогона всех девятнадцати наборов, и тысяча с лишним
     * мутаций заняла бы часы — то есть проверку перестали бы запускать.
     *
     * Обрыв меняет число прогнанных наборов, и это учтено в вердикте
     * (`compliance-mutation-worker.mjs`): «прогнаны не все наборы» — признак
     * сломанной подмены только тогда, когда **не упало ничего**.
     */
    bail: 1,
    /**
     * Один поток на прогон и без изоляции между наборами.
     *
     * Пакет чистый: ни один тест не пишет в глобальное состояние, журнал
     * неизменяем по построению, сети и файлов нет. Изоляция здесь покупает не
     * корректность, а девятнадцать запусков окружения на каждую из тысячи с
     * лишним мутаций.
     *
     * Что это меняет по смыслу — ничего: базовый прогон в этой же конфигурации
     * обязан быть зелёным, иначе рабочий процесс отвечает `BASELINE fail` и
     * мутационный прогон не начинается вовсе. То есть допущение «наборы не
     * мешают друг другу» проверяется на каждом запуске, а не предполагается.
     *
     * Один поток, а не пул: дорожек прогона несколько (`--concurrency`), и пул
     * внутри каждой из них на четырёхъядерной машине даёт не ускорение, а
     * борьбу за процессор — особенно когда в том же дереве работают другие руки.
     */
    isolate: false,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
  },
});
