import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_INTAKE_REASON_KEYS, IntakeErrorCode } from '../src/index';

const SOURCE_DIR = new URL('../src/', import.meta.url).pathname;

describe('пользовательского текста в пакете нет', () => {
  it('все причины — ключи локализации в пространстве intake', () => {
    for (const key of ALL_INTAKE_REASON_KEYS) {
      expect(key).toMatch(/^intake\.[a-z_]+\.[a-z_]+$/u);
    }
  });

  it('ключи уникальны', () => {
    expect(new Set(ALL_INTAKE_REASON_KEYS).size).toBe(ALL_INTAKE_REASON_KEYS.length);
  });

  it('коды ошибок — технические ключи, а не текст', () => {
    for (const code of Object.values(IntakeErrorCode)) {
      expect(code).toMatch(/^intake\.[a-z_.]+$/u);
    }
  });
});

describe('в исходниках нет строк для клиента', () => {
  /**
   * Проверка грубая, но ловит ровно то, что нужно: кириллическую строку в
   * коде вне комментария. Комментарии на русском в проекте норма, строки — нет
   * (`CLAUDE.md` → «Ни одной строки текста в коде»).
   */
  it('ни одного кириллического литерала вне комментариев', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SOURCE_DIR)) {
      if (!name.endsWith('.ts')) continue;
      const source = readFileSync(join(SOURCE_DIR, name), 'utf8');
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1');
      const literals = withoutComments.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/gu) ?? [];
      for (const literal of literals) {
        // Ссылка на документ — не текст для клиента. Якоря разделов в наших
        // документах кириллические, потому что кириллические заголовки; менять
        // их на номера значило бы ломать ссылку ради формы проверки.
        if (/^['"`]docs\//u.test(literal)) continue;
        if (/[Ѐ-ӿ]/u.test(literal)) offenders.push(`${name}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
