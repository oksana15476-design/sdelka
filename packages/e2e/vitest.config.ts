import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Мутационный прогон guard'ов — подмена **в памяти**, а не правка файла.
 *
 * Проверка «каждый guard домена роняет хотя бы один сквозной тест» требует по
 * очереди сломать каждый guard и посмотреть, заметит ли это контур. Очевидный
 * способ — переписать `packages/domain/src/guards.ts` и вернуть как было —
 * негоден по двум причинам, и обе серьёзные:
 *
 * 1. **Чужой пакет.** В `packages/domain` работают другие руки; скрипт,
 *    временно затирающий там файл, однажды затрёт чужую несохранённую правку.
 * 2. **Прерванный прогон.** Любое падение между «сломал» и «вернул» оставляет
 *    репозиторий с намеренно испорченным guard'ом. Дерево обязано оставаться
 *    байт-в-байт прежним не потому, что скрипт аккуратен, а потому, что он
 *    ничего не пишет.
 *
 * Поэтому подмена живёт в резолвере сборщика. При заданной `SDELKA_MUTATE_GUARD`
 * любой импорт модуля guard'ов — из `tranche.ts`, из `index.ts`, откуда угодно —
 * приводится к сгенерированному модулю, который берёт настоящую таблицу и
 * заменяет в ней одну реализацию на `() => true`. На диске при этом не меняется
 * ничего.
 *
 * `() => true` — это ровно та мутация, которой пользовался верификатор:
 * guard всегда пропускает. У guard'а, стоящего в отрицании (`¬g_payer_matches`
 * на ребре платежа третьего лица), тот же приём разворачивает ребро — переход
 * перестаёт срабатывать, и это тоже видимое изменение поведения.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const GUARDS_MODULE = resolve(HERE, '../domain/src/guards.ts');
const MUTANT_MODULE = resolve(HERE, '../domain/src/guards.__mutant__.ts');

export const GUARD_MUTATION_ENV = 'SDELKA_MUTATE_GUARD';

/** Пометка «это настоящий модуль guard'ов, не подменять». */
const ORIGINAL_QUERY = 'sdelka-original';

function guardMutation(): Plugin {
  return {
    name: 'sdelka:guard-mutation',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const target = process.env[GUARD_MUTATION_ENV];
      if (target === undefined || target === '') return null;
      // Импорт изнутри самого мутанта помечен запросом и ведёт к настоящему
      // модулю. Пометка нужна потому, что запрос модуля повторяется дважды: на
      // разборе импорта и на загрузке уже разрешённого пути — и во второй раз
      // «откуда пришли» неизвестно. Без пометки подмена сослалась бы на себя.
      if (source.includes(ORIGINAL_QUERY)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      const id = resolved.id.split('?')[0];
      if (id !== GUARDS_MODULE) return null;
      return MUTANT_MODULE;
    },
    load(id) {
      if (id !== MUTANT_MODULE) return null;
      const target = process.env[GUARD_MUTATION_ENV];
      if (target === undefined || target === '') return null;
      // Модуль сгенерирован, а не прочитан с диска: файла `guards.__mutant__.ts`
      // не существует и создавать его незачем.
      return [
        `import { GUARDS as ORIGINAL_GUARDS } from './guards?${ORIGINAL_QUERY}';`,
        `export * from './guards?${ORIGINAL_QUERY}';`,
        `const MUTATED = ${JSON.stringify(target)};`,
        `if (!(MUTATED in ORIGINAL_GUARDS)) {`,
        `  throw new Error('e2e.mutation.unknown_guard:' + MUTATED);`,
        `}`,
        `export const GUARDS = Object.freeze({ ...ORIGINAL_GUARDS, [MUTATED]: () => true });`,
        `export function evaluateGuard(guard, input) {`,
        `  return GUARDS[guard](input);`,
        `}`,
      ].join('\n');
    },
  };
}

export default defineConfig({
  plugins: [guardMutation()],
});
