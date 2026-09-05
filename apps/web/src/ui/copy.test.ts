import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/i18n/locales';
import { dictionaryOf } from '@/i18n/translate';
import { PENDING_COPY_KEYS, PENDING_LEGAL_REVIEW_KEYS } from './copy';
import { PENDING_LEGAL_SLOTS } from './primitives';

/**
 * Перечень черновиков обязан описывать то, что есть, а не то, что было.
 *
 * Список, переживший свои строки, ведёт себя ровно как разрешение, пережившее
 * свой текст (`forbidden-lexicon.mjs`, «исключение ничего не разрешает»): он
 * ничего не ломает сегодня и молча врёт завтра — либо преувеличивает объём
 * работы, либо прячет строку, которая приёмку так и не прошла.
 */
describe('черновики микрокопи', () => {
  it('каждый ключ черновика существует на трёх языках', () => {
    for (const key of PENDING_COPY_KEYS) {
      for (const locale of LOCALES) {
        const value = dictionaryOf(locale)[key];
        expect(typeof value, `${locale}: нет строки у ${key}`).toBe('string');
      }
    }
  });

  it('ключи, ждущие юриста, входят в перечень черновиков', () => {
    for (const key of PENDING_LEGAL_REVIEW_KEYS) {
      expect(PENDING_COPY_KEYS).toContain(key);
    }
  });

  /**
   * Два перечня не пересекаются по построению: ⚖-слот **не публикуется** до
   * формулировки юриста, а черновик публикуется и ждёт приёмки. Один ключ,
   * попавший в оба, означает, что строку одновременно показывают клиенту и
   * считают неопубликованной.
   */
  it('черновик и ⚖-слот — разные состояния одного ключа', () => {
    for (const key of PENDING_COPY_KEYS) {
      expect(PENDING_LEGAL_SLOTS).not.toContain(key);
    }
  });

  it('в перечне нет повторов', () => {
    expect(new Set(PENDING_COPY_KEYS).size).toBe(PENDING_COPY_KEYS.length);
  });
});
