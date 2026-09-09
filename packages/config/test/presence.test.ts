import { describe, expect, it } from 'vitest';
import { Presence, presenceOf } from '../src/presence.ts';

describe('presenceOf', () => {
  it('различает отсутствие ключа', () => {
    expect(presenceOf({}, 'ALPHA')).toBe(Presence.absent);
  });

  it('пустая строка — не отсутствие, а своё состояние', () => {
    expect(presenceOf({ ALPHA: '' }, 'ALPHA')).toBe(Presence.blank);
  });

  it('одни пробелы — тоже пусто: так выглядит несработавшая подстановка', () => {
    expect(presenceOf({ ALPHA: '   ' }, 'ALPHA')).toBe(Presence.blank);
    expect(presenceOf({ ALPHA: '\t\n' }, 'ALPHA')).toBe(Presence.blank);
  });

  it('значение с пробелами по краям остаётся значением', () => {
    expect(presenceOf({ ALPHA: ' x ' }, 'ALPHA')).toBe(Presence.present);
  });

  it('чужие ключи не считаются', () => {
    expect(presenceOf({ ALPHABET: 'x' }, 'ALPHA')).toBe(Presence.absent);
  });
});
