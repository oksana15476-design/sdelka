import { describe, expect, it } from 'vitest';
import { AuditErrorCode, canonical, canonicalDigest } from '../src/index';
import { expectAuditError } from './support/fixtures';

/**
 * Отказы канонической формы утверждаются **по коду и детали**, а не по классу.
 *
 * Причина в устройстве самой функции: пять её проверок бросают один класс
 * `AuditError`, и любые две из них ловят соседний вход. Снятая проверка цикла
 * доводит вызов до ограничителя глубины, снятая проверка «функция и символ» —
 * до проверки прототипа. На `toThrow(AuditError)` обе мутации оставались
 * незамеченными: проверено мутационным прогоном.
 */

describe('каноническая форма', () => {
  it('перестановка ключей не меняет хеш', () => {
    expect(canonicalDigest({ a: 1, b: 'x', c: [1, 2] })).toBe(
      canonicalDigest({ c: [1, 2], b: 'x', a: 1 }),
    );
  });

  it('вложенные объекты тоже приводятся к порядку', () => {
    expect(canonicalDigest({ outer: { z: 1, a: 2 } })).toBe(
      canonicalDigest({ outer: { a: 2, z: 1 } }),
    );
  });

  it('1n, 1 и "1" дают разные хеши', () => {
    const asBigint = canonicalDigest({ amount: 1n });
    const asNumber = canonicalDigest({ amount: 1 });
    const asString = canonicalDigest({ amount: '1' });
    expect(new Set([asBigint, asNumber, asString]).size).toBe(3);
  });

  it('true и "true" различимы', () => {
    expect(canonicalDigest(true)).not.toBe(canonicalDigest('true'));
  });

  it('null и отсутствие поля различимы', () => {
    expect(canonicalDigest({ a: null })).not.toBe(canonicalDigest({}));
  });

  it('строки с длиной: склейка соседних полей не даёт коллизии', () => {
    expect(canonicalDigest({ a: 'x', b: 'yz' })).not.toBe(canonicalDigest({ a: 'xy', b: 'z' }));
  });

  it('нецелое число отвергается — сумма в плавающей точке запрещена', () => {
    const error = expectAuditError(
      () => canonical({ amount: 12.5 }),
      AuditErrorCode.canonicalNonIntegerNumber,
    );
    expect(error.details['path']).toBe('$.amount');
  });

  it('NaN и Infinity отвергаются тем же кодом, что и дробь', () => {
    expectAuditError(() => canonical(Number.NaN), AuditErrorCode.canonicalNonIntegerNumber);
    expectAuditError(
      () => canonical(Number.POSITIVE_INFINITY),
      AuditErrorCode.canonicalNonIntegerNumber,
    );
  });

  it('undefined в поле отвергается: после базы оно неотличимо от отсутствия', () => {
    // Путь указывает на поле, а не на корень: иначе по отчёту не найти, какое
    // именно поле записи пришло пустым.
    const error = expectAuditError(
      () => canonical({ a: undefined }),
      AuditErrorCode.canonicalUnsupportedValue,
    );
    expect(error.details['path']).toBe('$.a');
    expect(error.details['type']).toBe('undefined');
  });

  it('функция и символ отвергаются с названным типом значения', () => {
    // Деталь `type` здесь не украшение: она отличает эту проверку от проверки
    // прототипа ниже. Без неё снятие любой из двух оставляет тест зелёным.
    expect(
      expectAuditError(() => canonical({ f: () => 1 }), AuditErrorCode.canonicalUnsupportedValue)
        .details['type'],
    ).toBe('function');
    expect(
      expectAuditError(
        () => canonical({ s: Symbol('x') }),
        AuditErrorCode.canonicalUnsupportedValue,
      ).details['type'],
    ).toBe('symbol');
  });

  it('дата и Map отвергаются как экземпляры класса, а не как значения', () => {
    expect(
      expectAuditError(() => canonical({ d: new Date(0) }), AuditErrorCode.canonicalUnsupportedValue)
        .details['type'],
    ).toBe('instance');
    expect(
      expectAuditError(() => canonical({ m: new Map() }), AuditErrorCode.canonicalUnsupportedValue)
        .details['type'],
    ).toBe('instance');
  });

  it('цикл отвергается как цикл, а не как слишком глубокая вложенность', () => {
    // Ровно тот случай, ради которого утверждается код: без проверки цикла
    // обход дошёл бы до ограничителя глубины и бросил бы `too_deep` — тот же
    // класс ошибки, другая причина, и отчёт назвал бы дежурному не ту.
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const error = expectAuditError(() => canonical(cyclic), AuditErrorCode.canonicalCycle);
    expect(error.details['path']).toBe('$.self');
  });

  it('цикл на глубине отвергается циклом, а не глубиной', () => {
    // Вторая форма того же: цикл, до которого доходят через несколько уровней.
    const inner: Record<string, unknown> = {};
    const outer = { a: { b: { c: inner } } };
    inner['back'] = outer;
    expectAuditError(() => canonical(outer), AuditErrorCode.canonicalCycle);
  });

  it('повтор одного и того же объекта в разных ветвях циклом не считается', () => {
    const shared = { a: 1 };
    expect(() => canonical({ left: shared, right: shared })).not.toThrow();
  });

  it('слишком глубокая вложенность отвергается своим кодом', () => {
    let deep: unknown = 1;
    for (let index = 0; index < 40; index += 1) {
      deep = { deep };
    }
    expectAuditError(() => canonical(deep), AuditErrorCode.canonicalTooDeep);
  });

  it('вложенность в пределах ограничителя проходит', () => {
    // Граница названа явно: иначе «слишком глубоко» нельзя отличить от
    // «глубже двух уровней не умеем».
    let deep: unknown = 1;
    for (let index = 0; index < 30; index += 1) {
      deep = { deep };
    }
    expect(() => canonical(deep)).not.toThrow();
  });
});
