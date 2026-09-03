import type { AuditChain } from './chain';
import { type Sha256Hex, ZERO_HASH } from './hash';
import { type AuditRecord, RECORD_FORMAT_VERSION, recordDigest } from './record';

/**
 * Проверка целостности.
 *
 * Две вещи, ради которых она написана именно так:
 *
 * 1. **Она не бросает.** Порванная цепочка — это состояние, о котором нужно
 *    отчитаться, а не аварийная ситуация. Аудитор обязан получить досье и вместе
 *    с ним отметку «вот здесь не сходится», а не пустой экран.
 * 2. **Она находит место разрыва и досматривает до конца.** «Сломано» без места
 *    бесполезно; одна подменённая запись и переписанный хвост требуют разных
 *    действий, а различает их только число разрывов и их расположение.
 */
export const CHAIN_BREAK_KINDS = [
  'genesis_missing',
  'hash_mismatch',
  'chain_id_mismatch',
  'seq_gap',
  'seq_duplicate',
  'prev_hash_mismatch',
  'time_regression',
] as const;
export type ChainBreakKind = (typeof CHAIN_BREAK_KINDS)[number];

export interface ChainBreak {
  /** Позиция в массиве: она осмысленна и тогда, когда `seq` подделан. */
  readonly index: number;
  readonly seq: number;
  readonly recordId: string | null;
  readonly kind: ChainBreakKind;
}

export type ChainVerification =
  | {
      readonly intact: true;
      readonly length: number;
      readonly head: Sha256Hex;
    }
  | {
      readonly intact: false;
      readonly length: number;
      readonly head: Sha256Hex | null;
      readonly firstBreak: ChainBreak;
      readonly breaks: readonly ChainBreak[];
      readonly breakCount: number;
    };

function broken(
  chain: AuditChain,
  breaks: readonly ChainBreak[],
  head: Sha256Hex | null,
): ChainVerification {
  const first = breaks[0];
  // Ветка недостижима: сюда попадают только непустые наборы. Разбирается явно
  // из-за `noUncheckedIndexedAccess` — как в `domain/src/ids.ts`.
  if (first === undefined) {
    return { intact: true, length: chain.records.length, head: head ?? ZERO_HASH };
  }
  return {
    intact: false,
    length: chain.records.length,
    head,
    firstBreak: first,
    breaks: Object.freeze([...breaks]),
    breakCount: breaks.length,
  };
}

function checkRecord(
  record: AuditRecord,
  index: number,
  previous: AuditRecord | null,
  chain: AuditChain,
  breaks: ChainBreak[],
): void {
  const at = (kind: ChainBreak['kind']): ChainBreak =>
    Object.freeze({ index, seq: record.seq, recordId: record.recordId, kind });

  if (recordDigest(record) !== record.recordHash) {
    breaks.push(at('hash_mismatch'));
  }
  if (record.chainId !== chain.chainId) {
    breaks.push(at('chain_id_mismatch'));
  }
  if (record.seq !== index) {
    // Позиция и объявленный номер разошлись: запись либо изъята, либо вставлена.
    if (previous !== null && record.seq === previous.seq) {
      breaks.push(at('seq_duplicate'));
    } else {
      breaks.push(at('seq_gap'));
    }
  }
  if (previous === null) {
    if (record.prevHash !== ZERO_HASH) {
      breaks.push(at('prev_hash_mismatch'));
    }
    return;
  }
  if (record.prevHash !== previous.recordHash) {
    breaks.push(at('prev_hash_mismatch'));
  }
  if (record.recordedAt < previous.recordedAt) {
    breaks.push(at('time_regression'));
  }
}

export function verifyChain(chain: AuditChain): ChainVerification {
  const breaks: ChainBreak[] = [];
  const first = chain.records[0];
  if (first === undefined) {
    return broken(
      chain,
      [Object.freeze({ index: 0, seq: 0, recordId: null, kind: 'genesis_missing' as const })],
      null,
    );
  }
  if (first.seq !== 0 || first.body.kind !== 'chain_opened' || first.version !== RECORD_FORMAT_VERSION) {
    breaks.push(
      Object.freeze({
        index: 0,
        seq: first.seq,
        recordId: first.recordId,
        kind: 'genesis_missing' as const,
      }),
    );
  }
  let previous: AuditRecord | null = null;
  for (let index = 0; index < chain.records.length; index += 1) {
    const record = chain.records[index];
    if (record === undefined) {
      continue;
    }
    checkRecord(record, index, previous, chain, breaks);
    previous = record;
  }
  const head = previous === null ? null : previous.recordHash;
  if (breaks.length > 0) {
    return broken(chain, breaks, head);
  }
  return { intact: true, length: chain.records.length, head: head ?? ZERO_HASH };
}
