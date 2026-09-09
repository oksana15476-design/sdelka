import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envVariableNames } from '../src/registry.ts';

/**
 * Перечень не расходится с деревом.
 *
 * Это и есть ответ на исходную беду: переменные заводились там, где были нужны,
 * и узнать полный список можно было только грепом. Здесь греп выполняется
 * тестом. Прочитал код переменную, которой нет в перечне, — прогон красный, и
 * чинится это одной записью в `registry.ts` плюс блоком в `.env.example`.
 *
 * Проверка идёт в одну сторону: **всё прочитанное обязано быть в перечне**.
 * Обратное (всё перечисленное обязано читаться) не требуется: переменная может
 * быть объявлена под ещё не написанный читатель, и ронять на этом прогон значило
 * бы запрещать объявлять до реализации.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', 'coverage']);
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.sh'];

/** Прямое чтение: `process.env.NAME` и `process.env['NAME']`. */
const DIRECT = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
];

/**
 * Косвенное чтение: имя лежит в константе (`process.env[MUTATION_ENV]`), и
 * прямой шаблон его не видит. Ловится по самому имени: у наших переменных общий
 * приставочный признак, и это единственное, чем косвенное чтение отличимо от
 * произвольной строки.
 */
const INDIRECT = [/['"`](SDELKA_[A-Z0-9_]+)['"`]/g, /\$\{?(SDELKA_[A-Z0-9_]+)/g];

type Sighting = { readonly name: string; readonly file: string };

/**
 * Сам обход из обхода исключён: файл, который ищет шаблон чтения, обязан этот
 * шаблон содержать — иначе его нечем описать. Единственное исключение, и оно
 * названо путём, а не признаком, чтобы под него нельзя было спрятать второй.
 */
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
}

function sightings(): readonly Sighting[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(REPO_ROOT, root), files);

  const found: Sighting[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of [...DIRECT, ...INDIRECT]) {
      for (const match of text.matchAll(pattern)) {
        found.push({ name: match[1] as string, file: file.slice(REPO_ROOT.length) });
      }
    }
  }
  return found;
}

describe('перечень против дерева', () => {
  const known = new Set(envVariableNames());
  const seen = sightings();

  it('обход находит хоть что-то — иначе проверка проходит вхолостую', () => {
    expect(seen.length).toBeGreaterThan(10);
  });

  it('каждая читаемая переменная есть в перечне', () => {
    const unknown = seen
      .filter((sighting) => !known.has(sighting.name))
      .map((sighting) => `${sighting.name} (${sighting.file})`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it('строка подключения и стенды в самом деле попадают в обход', () => {
    const names = new Set(seen.map((sighting) => sighting.name));
    expect(names).toContain('SDELKA_DATABASE_URL');
    expect(names).toContain('SDELKA_MUTATE_LEDGER');
    expect(names).toContain('VERIFY_PORT');
  });
});
