import { AuditError, AuditErrorCode } from '@sdelka/audit';
import { DomainError, RejectionCode } from '@sdelka/domain';
import { InvariantCode, LedgerError, LedgerErrorCode } from '@sdelka/ledger';
import { describe, expect, it } from 'vitest';
import { DbError, DbErrorCode } from '../src/errors.ts';
import { TRANSLATED_CONSTRAINTS, translateStorageError } from '../src/store/errors.ts';

/**
 * Перевод отказов базы — без базы.
 *
 * Набор офлайновый намеренно: правило «отказ базы приезжает тем же ключом, что
 * и проверка кода» обязано проверяться у каждого, а не только у того, у кого
 * поднят кластер. Живая база проверяет вторую половину — что названные здесь
 * ограничения в схеме действительно есть (`test/int/store-errors.int.test.ts`).
 */
function driverError(fields: Record<string, string>): Error {
  return Object.assign(new Error(fields['message'] ?? 'boom'), fields);
}

describe('перевод отказов базы', () => {
  it('ключ учёта, поднятый триггером, становится LedgerError', () => {
    const translated = translateStorageError(
      driverError({ message: LedgerErrorCode.entryTooFewPostings, detail: 'entry_id=e1' }),
    );
    expect(translated).toBeInstanceOf(LedgerError);
    expect((translated as LedgerError).code).toBe(LedgerErrorCode.entryTooFewPostings);
    expect((translated as LedgerError).details['detail']).toBe('entry_id=e1');
  });

  it('ключ инварианта учёта — тот же класс: два перечня, одна ошибка', () => {
    // `ledger.invariant.*` живут в `InvariantCode`, а не в `LedgerErrorCode`.
    // Заводить им третий класс значило бы, что дежурный ловит одно и то же
    // нарушение двумя разными способами.
    const translated = translateStorageError(
      driverError({ message: InvariantCode.entryUnbalanced }),
    );
    expect(translated).toBeInstanceOf(LedgerError);
    expect((translated as LedgerError).code).toBe(InvariantCode.entryUnbalanced);
  });

  it('ключ журнала аудита становится AuditError', () => {
    const translated = translateStorageError(
      driverError({ message: AuditErrorCode.correctionTargetMissing }),
    );
    expect(translated).toBeInstanceOf(AuditError);
    expect((translated as AuditError).code).toBe(AuditErrorCode.correctionTargetMissing);
  });

  it('ключ, которого в коде нет вовсе, становится DbError', () => {
    const translated = translateStorageError(driverError({ message: DbErrorCode.ledgerAppendOnly }));
    expect(translated).toBeInstanceOf(DbError);
    expect((translated as DbError).code).toBe(DbErrorCode.ledgerAppendOnly);
  });

  it('имя ограничения переводится в правило кода', () => {
    const selfDealing = translateStorageError(
      driverError({ message: 'duplicate key', constraint: 'deal_parties_distinct' }),
    );
    expect(selfDealing).toBeInstanceOf(LedgerError);
    expect((selfDealing as LedgerError).code).toBe(LedgerErrorCode.settlementSelfDealing);

    const doublePayout = translateStorageError(
      driverError({ message: 'duplicate key', constraint: 'payout_one_active_per_tranche' }),
    );
    expect(doublePayout).toBeInstanceOf(DomainError);
    expect((doublePayout as DomainError).code).toBe(RejectionCode.guardFailed);
    // Имя guard'а обязано доехать: «отказ автомата» без указания правила
    // дежурному не говорит ничего.
    expect((doublePayout as DomainError).message).toBe('g_no_active_payout');
  });

  it('незнакомая ошибка возвращается как есть, а не превращается в знакомую', () => {
    // Тот же довод, по которому `isDatabaseUnreachable` отказывается угадывать:
    // подстановка похожего ключа делает отчёт дежурного ложным ровно в тот
    // момент, когда он нужен.
    const raw = driverError({ message: 'connection terminated unexpectedly' });
    expect(translateStorageError(raw)).toBe(raw);
  });

  it('уже названная ошибка не пересобирается', () => {
    // Без этого собственный отказ хранилища пересобирался бы по своему же
    // сообщению — с тем же кодом, но без подробностей: `details` у него не
    // поле драйвера, а наше.
    const named = new DbError(DbErrorCode.entryCeilingMismatch, { entryId: 'e-1' });
    expect(translateStorageError(named)).toBe(named);
  });

  it('перевод не выдумывает ключей: каждый ведёт в известный перечень', () => {
    const known = new Set<string>([
      ...Object.values(LedgerErrorCode),
      ...Object.values(InvariantCode),
      ...Object.values(AuditErrorCode),
      ...Object.values(DbErrorCode),
      ...Object.values(RejectionCode),
    ]);
    for (const constraint of TRANSLATED_CONSTRAINTS) {
      const translated = translateStorageError(driverError({ message: 'x', constraint }));
      expect(translated).toBeInstanceOf(Error);
      const code = (translated as { code?: unknown }).code;
      expect(typeof code, constraint).toBe('string');
      expect(known.has(code as string), `${constraint} → ${String(code)}`).toBe(true);
    }
  });
});
