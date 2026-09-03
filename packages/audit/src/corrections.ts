import { type AuditChain, findRecord } from './chain';
import type { AuditRecord } from './record';

/**
 * Исправления.
 *
 * Красная линия №11 и `FUNCTIONAL.md` инвариант 22: журнал не редактируется,
 * исправление — только новой записью со ссылкой на предыдущую. Отсюда следствие,
 * которое легко упустить: исходная запись остаётся в цепочке навсегда и остаётся
 * видимой. «Действующее представление» — это не подмена исходной записи, а
 * исходная запись плюс упорядоченная цепочка исправлений к ней.
 */
export interface EffectiveView {
  readonly original: AuditRecord;
  /** В порядке цепочки: исправление исправления идёт после исправляемого. */
  readonly corrections: readonly AuditRecord[];
}

/** Исправления к записи, включая исправления исправлений, в порядке цепочки. */
export function correctionsOf(chain: AuditChain, recordId: string): readonly AuditRecord[] {
  const covered = new Set<string>([recordId]);
  const found: AuditRecord[] = [];
  for (const record of chain.records) {
    if (record.body.kind !== 'correction') {
      continue;
    }
    if (covered.has(record.body.correctsRecordId)) {
      covered.add(record.recordId);
      found.push(record);
    }
  }
  return Object.freeze(found);
}

export function effectiveView(chain: AuditChain, recordId: string): EffectiveView | null {
  const original = findRecord(chain, recordId);
  if (original === null) {
    return null;
  }
  return Object.freeze({ original, corrections: correctionsOf(chain, recordId) });
}
