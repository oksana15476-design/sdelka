import { describe, expect, it } from 'vitest';
import { anchorCoverage, verifyAgainstAnchor, verifyChain } from '../src/index';
import {
  ANALYST,
  COMPLIANCE_POLICY,
  TRANCHE,
  anchorAt,
  at,
  dossierChain,
  newChain,
  source,
} from './support/fixtures';
import { appendRecord } from '../src/index';

function forgedFromScratch() {
  // Противник, у которого есть база и наш код: он переписывает цепочку целиком
  // и пересчитывает все хеши. Изнутри такая подделка безупречна.
  let chain = newChain();
  chain = appendRecord(chain, {
    recordId: 'rec-act',
    recordedAt: at(1),
    actor: ANALYST,
    subject: TRANCHE,
    body: {
      kind: 'decision_made',
      outcomeKey: 'block',
      policy: COMPLIANCE_POLICY,
      reasonKeys: [],
      evidence: [source(1)],
    },
  });
  return chain;
}

describe('внешний якорь', () => {
  it('якорь сходится с целой цепочкой', () => {
    const chain = dossierChain();
    const head = chain.records[chain.records.length - 1];
    if (head === undefined) {
      expect.unreachable();
      return;
    }
    expect(verifyAgainstAnchor(chain, anchorAt(head, 60))).toBeNull();
  });

  it('якорь ловит подмену записи, лежащей до него, даже когда хеши пересчитаны', () => {
    const honest = dossierChain();
    const record = honest.records[1];
    if (record === undefined) {
      expect.unreachable();
      return;
    }
    const anchor = anchorAt(record, 60);
    const forged = forgedFromScratch();
    // Изнутри подделка целостна — и только якорь показывает подмену.
    expect(verifyChain(forged).intact).toBe(true);
    expect(verifyAgainstAnchor(forged, anchor)?.kind).toBe('anchor_hash_mismatch');
  });

  it('якорь чужой цепочки распознаётся отдельно от подмены', () => {
    const chain = dossierChain();
    const head = chain.records[chain.records.length - 1];
    if (head === undefined) {
      expect.unreachable();
      return;
    }
    const alien = { ...anchorAt(head, 60), chainId: 'chain:deal-2' };
    expect(verifyAgainstAnchor(chain, alien)?.kind).toBe('anchor_chain_mismatch');
  });

  it('якорь на номер, которого в цепочке нет: хвост отрезан', () => {
    const chain = dossierChain();
    const head = chain.records[chain.records.length - 1];
    if (head === undefined) {
      expect.unreachable();
      return;
    }
    const beyond = { ...anchorAt(head, 60), seq: head.seq + 5 };
    expect(verifyAgainstAnchor(chain, beyond)?.kind).toBe('anchor_seq_missing');
  });

  it('записи после последнего якоря честно помечены непокрытыми', () => {
    const chain = dossierChain();
    const middle = chain.records[4];
    if (middle === undefined) {
      expect.unreachable();
      return;
    }
    const coverage = anchorCoverage(chain, [anchorAt(middle, 60)]);
    expect(coverage.anchoredThroughSeq).toBe(4);
    expect(coverage.unanchoredTail).toBe(chain.records.length - 5);
    expect(coverage.brokenAnchors).toEqual([]);
  });

  it('без якорей непокрыта вся цепочка, и это сказано, а не умолчано', () => {
    const chain = dossierChain();
    const coverage = anchorCoverage(chain, []);
    expect(coverage.anchoredThroughSeq).toBeNull();
    expect(coverage.unanchoredTail).toBe(chain.records.length);
  });

  it('несошедшийся якорь не двигает границу покрытия', () => {
    const chain = dossierChain();
    const middle = chain.records[4];
    const head = chain.records[chain.records.length - 1];
    if (middle === undefined || head === undefined) {
      expect.unreachable();
      return;
    }
    const broken = { ...anchorAt(head, 60), headHash: middle.recordHash };
    const coverage = anchorCoverage(chain, [anchorAt(middle, 60), broken]);
    expect(coverage.anchoredThroughSeq).toBe(4);
    expect(coverage.brokenAnchors).toHaveLength(1);
  });
});
