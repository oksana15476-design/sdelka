import { AuditErrorCode } from '@sdelka/audit';
import { AUTH_REASON_KEYS } from '@sdelka/auth';
import { InvariantCode, LedgerErrorCode } from '@sdelka/ledger';
import { describe, expect, it } from 'vitest';
import { DbErrorCode } from '../src/errors.ts';
import { CODE_SQL, raisedCodes } from './support/sql.ts';

/**
 * Ключи ошибок базы — те же, что в коде, буква в букву.
 *
 * Второй ключ для того же нарушения означал бы, что дежурный читает разные
 * сообщения об одном и том же в зависимости от того, кто поймал — код или база.
 * А ключ, которого нет нигде, означает, что сообщение никем не разбирается.
 */
const KNOWN = new Set<string>([
  ...Object.values(LedgerErrorCode),
  ...Object.values(InvariantCode),
  ...Object.values(AuditErrorCode),
  // Правило, у которого имя в коде уже есть, база поднимает **тем же** именем:
  // отказ «сессия отозвана» читается одинаково независимо от того, поймал его
  // `decideCapability` или триггер вставки гранта.
  ...Object.values(AUTH_REASON_KEYS),
  ...Object.values(DbErrorCode),
]);

describe('ключи ошибок в SQL', () => {
  const raised = raisedCodes(CODE_SQL);

  it('в миграциях вообще есть RAISE', () => {
    expect(raised.length).toBeGreaterThan(0);
  });

  it('каждый поднимаемый ключ известен коду', () => {
    const unknown = raised.filter((code) => !KNOWN.has(code));
    expect(unknown).toEqual([]);
  });

  it('ни один ключ не является пользовательским текстом', () => {
    // Три языка (`CLAUDE.md`): ни одной строки пользовательского текста в коде.
    // Технический ключ — латиница, точки и подчёркивания; ни пробела, ни
    // кириллицы, ни заглавных.
    for (const code of raised) {
      expect(code, code).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/u);
    }
  });

  it('коды инвариантов учёта присутствуют в представлении сводки', () => {
    // `v_ledger_invariant_violation` обязано уметь доложить о каждом виде
    // расхождения, который умеет находить код. Пропущенный код — это
    // расхождение, которое база видит, но не называет.
    for (const code of Object.values(InvariantCode)) {
      expect(CODE_SQL, code).toContain(`'${code}'`);
    }
  });

  it('в SQL нет ключей инвариантов, которых нет в InvariantCode', () => {
    const inSql = [...CODE_SQL.matchAll(/'(ledger\.invariant\.[a-z_]+)'/gu)].map(
      (item) => item[1] ?? '',
    );
    const known = new Set<string>(Object.values(InvariantCode));
    expect([...new Set(inSql)].filter((code) => !known.has(code))).toEqual([]);
  });
});
