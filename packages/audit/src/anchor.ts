import type { AuditChain } from './chain';
import type { Anchor } from './ports';

/**
 * Внешний якорь.
 *
 * Хеш-цепочка сама по себе защищает от точечной правки, но не от того, кто
 * перепишет цепочку целиком и пересчитает все хеши: изнутри такая подделка
 * выглядит безупречной. Отличить её может только значение, опубликованное там,
 * где мы его переписать не можем.
 *
 * `BACKLOG.md` E7-5: записи, созданные до появления якоря, останутся без него
 * навсегда. Поэтому непокрытый хвост — часть ответа, а не умолчание.
 */
export const ANCHOR_MISMATCH_KINDS = [
  'anchor_chain_mismatch',
  'anchor_seq_missing',
  'anchor_hash_mismatch',
] as const;
export type AnchorMismatchKind = (typeof ANCHOR_MISMATCH_KINDS)[number];

export interface AnchorMismatch {
  readonly anchor: Anchor;
  readonly kind: AnchorMismatchKind;
}

/** `null` — якорь сходится с цепочкой. */
export function verifyAgainstAnchor(chain: AuditChain, anchor: Anchor): AnchorMismatch | null {
  if (anchor.chainId !== chain.chainId) {
    return Object.freeze({ anchor, kind: 'anchor_chain_mismatch' as const });
  }
  const record = chain.records.find((item) => item.seq === anchor.seq);
  if (record === undefined) {
    // Якорь есть, а записи под ним нет: хвост цепочки отрезан целиком.
    return Object.freeze({ anchor, kind: 'anchor_seq_missing' as const });
  }
  if (record.recordHash !== anchor.headHash) {
    return Object.freeze({ anchor, kind: 'anchor_hash_mismatch' as const });
  }
  return null;
}

export interface AnchorCoverage {
  /** До какого номера включительно цепочка подтверждена снаружи. `null` — ни одного. */
  readonly anchoredThroughSeq: number | null;
  /** Записи после последнего сошедшегося якоря: они опираются только на нас. */
  readonly unanchoredTail: number;
  readonly brokenAnchors: readonly AnchorMismatch[];
}

export function anchorCoverage(
  chain: AuditChain,
  anchors: readonly Anchor[],
): AnchorCoverage {
  const broken: AnchorMismatch[] = [];
  let through: number | null = null;
  for (const anchor of anchors) {
    const mismatch = verifyAgainstAnchor(chain, anchor);
    if (mismatch !== null) {
      broken.push(mismatch);
      continue;
    }
    if (through === null || anchor.seq > through) {
      through = anchor.seq;
    }
  }
  const covered = through;
  const unanchoredTail =
    covered === null
      ? chain.records.length
      : chain.records.filter((record) => record.seq > covered).length;
  return Object.freeze({
    anchoredThroughSeq: covered,
    unanchoredTail,
    brokenAnchors: Object.freeze(broken),
  });
}
