import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AuditErrorCode } from '../src/index';

/**
 * Сторож против проверок без падающего теста.
 *
 * Мутационный прогон показал класс дефекта: проверка есть, а теста, который от
 * её снятия падает, нет. В журнале это особенно дорого — все проверки бросают
 * один класс `AuditError`, поэтому `toThrow(AuditError)` истинен и когда
 * сработала соседняя проверка. Отличает их только **код**.
 *
 * Отсюда правило, которое держит этот файл: на каждое место `throw` в `src`
 * пакета в тестах обязано быть хотя бы одно утверждение соответствующего кода
 * поимённо. Новый `throw` без такого утверждения роняет набор — и разговор о
 * том, что «проверка же есть», не состоится.
 *
 * Тест считает упоминания вида `AuditErrorCode.<имя>` в тестах пакета, кроме
 * самого себя: собственные перечни ниже иначе засчитывались бы за покрытие.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TEST = fileURLToPath(new URL('./', import.meta.url));
const SELF = 'error-codes.test.ts';

function readAll(directory: string, keep: (name: string) => boolean): readonly string[] {
  const texts: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) texts.push(...readAll(`${directory}${entry.name}/`, keep));
    else if (keep(entry.name)) texts.push(readFileSync(`${directory}${entry.name}`, 'utf8'));
  }
  return texts;
}

function countByCode(texts: readonly string[], pattern: RegExp): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      const code = AuditErrorCode[name as keyof typeof AuditErrorCode];
      if (code === undefined) continue;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return counts;
}

const throwSites = (): ReadonlyMap<string, number> =>
  countByCode(
    readAll(SRC, (name) => name.endsWith('.ts')),
    /new AuditError\(\s*AuditErrorCode\.(\w+)/gu,
  );

const assertionsInTests = (): ReadonlyMap<string, number> =>
  countByCode(
    readAll(TEST, (name) => name.endsWith('.ts') && name !== SELF),
    /AuditErrorCode\.(\w+)/gu,
  );

/**
 * Места, до которых вход не доходит по построению, — с обоснованием на каждое.
 *
 * Списку положено быть коротким и объяснённым: без обоснования он превращается
 * в место, куда прячут непокрытое.
 */
const UNREACHABLE: readonly { readonly code: string; readonly why: string }[] = [
  {
    code: AuditErrorCode.canonicalUnsupportedValue,
    why:
      'canonical.ts: ранняя проверка `child === undefined` внутри объекта неотличима от общей ' +
      'проверки типа: обе дают тот же код, тот же путь и ту же деталь `type: undefined`. ' +
      'Мутация этой строки эквивалентна — поведение пакета от неё не меняется, и утверждать ' +
      'её отдельно нечем. Наблюдаемый договор проверен в canonical.test.ts.',
  },
];

/**
 * Коды, объявленные в перечне, но не бросаемые ни одной строкой `src`.
 *
 * `chainIdMismatch` — заявка на проверку «запись из чужой цепочки», которой в
 * `chain.ts` и `verify.ts` нет: сцепка проверяется по хешу и по номеру, а поле
 * `chainId` записи с цепочкой не сверяется нигде. Либо проверка, либо код —
 * решение владельца; здесь только фиксация факта, чтобы он не потерялся.
 */
const KNOWN_ORPHANS: readonly AuditErrorCode[] = [AuditErrorCode.chainIdMismatch];

describe('у каждой проверки журнала есть тест, который её называет', () => {
  it('код каждого места throw утверждается в тестах поимённо', () => {
    const sites = throwSites();
    const asserted = assertionsInTests();
    const excused = new Map<string, number>();
    for (const item of UNREACHABLE) {
      excused.set(item.code, (excused.get(item.code) ?? 0) + 1);
    }
    const gaps: string[] = [];
    for (const [code, count] of sites) {
      const required = count - (excused.get(code) ?? 0);
      if ((asserted.get(code) ?? 0) < required) {
        gaps.push(`${code}: мест ${count}, недостижимых ${excused.get(code) ?? 0}, утверждений ${asserted.get(code) ?? 0}`);
      }
    }
    expect(gaps).toEqual([]);
  });

  it('осиротевшие коды — только те, что названы поимённо', () => {
    const sites = throwSites();
    const orphans = Object.values(AuditErrorCode).filter((code) => !sites.has(code));
    expect(orphans).toEqual(KNOWN_ORPHANS);
  });

  it('каждое недостижимое место названо и объяснено', () => {
    const sites = throwSites();
    for (const item of UNREACHABLE) {
      expect(sites.has(item.code)).toBe(true);
      expect(item.why.length).toBeGreaterThan(80);
    }
  });

  it('сторож видит исходник, а не пустоту', () => {
    // Без этого утверждения ошибка в пути превратила бы весь файл в тавтологию:
    // пустое множество мест покрывается пустым множеством утверждений.
    expect(throwSites().size).toBeGreaterThan(10);
    expect(assertionsInTests().size).toBeGreaterThan(10);
  });
});
