import { describe, expect, it } from 'vitest';
import {
  INTAKE_REASON_KEYS,
  REFERENCE_LENGTH,
  matchReference,
  normalizeReference,
  parseReference,
  paymentReference,
  referenceCheckCharacter,
} from '../src/index';
import { POLICY } from './support/fixtures';

const REFERENCE = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });

describe('референс уникален по траншу', () => {
  it('разные транши одной сделки дают разные референсы', () => {
    const first = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' });
    const second = paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T2' });
    expect(first).not.toBe(second);
  });

  it('референс детерминирован: одна и та же пара кодов даёт одно значение', () => {
    expect(paymentReference({ dealCode: 'D7K2M9Q4', trancheCode: 'T1' })).toBe(REFERENCE);
  });

  it('пустой код отвергается', () => {
    expect(() => paymentReference({ dealCode: '   ', trancheCode: 'T1' })).toThrow();
  });
});

describe('нормализация переживает путь через назначение платежа', () => {
  it('регистр, пробелы и дефисы выбрасываются', () => {
    const raw = ` ${REFERENCE.slice(0, 4)}-${REFERENCE.slice(4)} `.toLowerCase();
    expect(normalizeReference(raw)).toBe(REFERENCE as string);
  });

  it('сопоставление после нормализации даёт точное совпадение', () => {
    const raw = `оплата по договору ${REFERENCE}`;
    expect(matchReference(REFERENCE, raw, POLICY).degree).toBe('exact');
  });
});

describe('контрольный знак', () => {
  it('референс собирается с сошедшимся контрольным знаком', () => {
    const parsed = parseReference(REFERENCE);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksumValid).toBe(true);
    expect(REFERENCE.length).toBe(REFERENCE_LENGTH);
  });

  it('ловит любую одиночную ошибку знака', () => {
    const payload = (REFERENCE as string).slice(0, REFERENCE_LENGTH - 1);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let checked = 0;
    for (let position = 2; position < payload.length; position += 1) {
      const original = payload[position];
      for (const replacement of alphabet) {
        if (replacement === original) continue;
        const broken = `${payload.slice(0, position)}${replacement}${payload.slice(position + 1)}`;
        expect(referenceCheckCharacter(broken)).not.toBe(
          (REFERENCE as string).slice(REFERENCE_LENGTH - 1),
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('ловит перестановку соседних различных знаков', () => {
    const payload = (REFERENCE as string).slice(0, REFERENCE_LENGTH - 1);
    let swapsChecked = 0;
    for (let position = 2; position + 1 < payload.length; position += 1) {
      const left = payload[position];
      const right = payload[position + 1];
      if (left === undefined || right === undefined || left === right) continue;
      const swapped = `${payload.slice(0, position)}${right}${left}${payload.slice(position + 2)}`;
      expect(referenceCheckCharacter(swapped)).not.toBe(
        (REFERENCE as string).slice(REFERENCE_LENGTH - 1),
      );
      swapsChecked += 1;
    }
    expect(swapsChecked).toBeGreaterThan(0);
  });
});

describe('искажённый референс не выдаётся за точный', () => {
  it('одна изменённая буква даёт «искажён», а не «совпал»', () => {
    const broken = `${(REFERENCE as string).slice(0, 5)}X${(REFERENCE as string).slice(6)}`;
    const match = matchReference(REFERENCE, broken, POLICY);
    expect(match.degree).toBe('damaged');
    expect(match.checksumValid).toBe(false);
    expect(match.reasons).toContain(INTAKE_REASON_KEYS.referenceChecksumFailed);
  });

  it('референс чужой сделки не считается искажением своей', () => {
    const foreign = paymentReference({ dealCode: 'ZZZZZZZZ', trancheCode: '99' });
    expect(matchReference(REFERENCE, foreign, POLICY).degree).toBe('foreign');
  });

  it('референса нет вовсе', () => {
    expect(matchReference(REFERENCE, null, POLICY).degree).toBe('absent');
    expect(matchReference(REFERENCE, '   ', POLICY).degree).toBe('absent');
  });
});

describe('разбор', () => {
  it('строка не той длины на референс не похожа', () => {
    expect(parseReference('SD123')).toBeNull();
  });

  it('референс с несошедшимся знаком разбирается, но помечается', () => {
    const broken = `${(REFERENCE as string).slice(0, REFERENCE_LENGTH - 1)}0`;
    const parsed = parseReference(broken);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksumValid).toBe(
      (REFERENCE as string).slice(REFERENCE_LENGTH - 1) === '0',
    );
  });

  it('коды сделки и транша достаются из фиксированных позиций', () => {
    const parsed = parseReference(REFERENCE);
    expect(parsed?.parts.dealCode).toBe('D7K2M9Q4');
    expect(parsed?.parts.trancheCode).toBe('T1');
  });
});
