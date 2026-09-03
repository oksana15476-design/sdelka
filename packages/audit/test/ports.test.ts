import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AnchorPort,
  type Sha256Hex,
  type TimestampPort,
  appendRecord,
  verifyChain,
} from '../src/index';
import { PAYOUT, SYSTEM, at, dossierChain } from './support/fixtures';

const SRC = join(import.meta.dirname, '..', 'src');

describe('порты, а не интеграции', () => {
  it('в пакете нет ни сети, ни обращений к окружению', () => {
    // Денежный домен тестируется без сети (CLAUDE.md), а секреты живут в
    // окружении интеграции. Проверяется перебором файлов, а не обещанием.
    const forbidden = [/\bfetch\s*\(/u, /https?:\/\//u, /process\.env/u, /node:https?/u];
    const offenders: string[] = [];
    for (const name of readdirSync(SRC)) {
      const text = readFileSync(join(SRC, name), 'utf8');
      if (forbidden.some((pattern) => pattern.test(text))) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('порт метки времени подписывает отпечаток, а не содержимое записи', async () => {
    const seen: Sha256Hex[] = [];
    // Детерминированный дублёр: ни сети, ни времени, ни случайности.
    const port: TimestampPort = {
      stamp: (digest) => {
        seen.push(digest);
        return Promise.resolve({
          provider: 'tsa-fake',
          issuedAt: at(70),
          digest,
          token: 'fake+token==',
        });
      },
    };
    const chain = dossierChain();
    const record = chain.records[5];
    if (record === undefined) {
      expect.unreachable();
      return;
    }
    const token = await port.stamp(record.recordHash);
    expect(seen).toEqual([record.recordHash]);
    expect(token.digest).toBe(record.recordHash);
  });

  it('метка ложится отдельной записью: покрытая запись не меняется', async () => {
    const chain = dossierChain();
    const covered = chain.records[7];
    if (covered === undefined) {
      expect.unreachable();
      return;
    }
    const port: TimestampPort = {
      stamp: (digest) =>
        Promise.resolve({ provider: 'tsa-fake', issuedAt: at(70), digest, token: 'fake==' }),
    };
    const token = await port.stamp(covered.recordHash);
    const extended = appendRecord(chain, {
      recordId: 'rec-stamp-2',
      recordedAt: at(71),
      actor: SYSTEM,
      subject: PAYOUT,
      body: {
        kind: 'timestamp_token',
        coversRecordId: covered.recordId,
        coveredHash: covered.recordHash,
        timestamp: token,
      },
    });
    // Та же запись, тот же хеш: метка ничего в ней не изменила.
    expect(extended.records[7]).toBe(covered);
    expect(verifyChain(extended).intact).toBe(true);
  });

  it('порт якоря публикует головной хеш и ничего кроме', async () => {
    const published: string[] = [];
    const port: AnchorPort = {
      publish: (chainId, seq, headHash) => {
        published.push(`${chainId}:${seq}:${headHash}`);
        return Promise.resolve({
          chainId,
          seq,
          headHash,
          anchoredAt: at(72),
          provider: 'anchor-fake',
          proof: 'fake==',
        });
      },
    };
    const chain = dossierChain();
    const head = chain.records[chain.records.length - 1];
    if (head === undefined) {
      expect.unreachable();
      return;
    }
    const anchor = await port.publish(chain.chainId, head.seq, head.recordHash);
    expect(anchor.headHash).toBe(head.recordHash);
    expect(published).toHaveLength(1);
  });
});
