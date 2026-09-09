import {
  type AuditActor,
  type AuditChain,
  appendRecord,
  auditActor,
  auditAmount,
  auditFingerprint,
  auditInstant,
  auditRef,
  genesisChain,
  policyRef,
  rawSourceRef,
} from '@sdelka/audit';
import { appendAudit, appendJournal } from '@sdelka/db';
import {
  type EntryMeta,
  type Journal,
  type JournalEntry,
  appendEntry,
  clientKey,
  clientTopUp,
  emptyJournal,
  lockForTranche,
  unlockToClientAccount,
} from '@sdelka/ledger';
import { money } from '@sdelka/money';
import { pooled } from './drill.ts';

/**
 * Данные, которые копия обязана донести.
 *
 * Их две породы, и обе намеренно: **журнал учёта** — то, из чего считается,
 * кому сколько причитается, и **вечный журнал** — то, чем это доказывается.
 * Копия, донёсшая первое без второго, бесполезна ровно так же, как и наоборот.
 *
 * Суммы — заведомо больше 2^53 в одной из записей: через число такая величина
 * проходит с потерей, и потеря молчаливая (красная линия №4). Копия обязана
 * донести её знак в знак.
 */
const GEL = 'GEL' as const;
const BUYER = clientKey('drill-buyer');
const SELLER = clientKey('drill-seller');
const DEAL = 'drill-deal';
const TRANCHE = 'drill-tranche';

export const CHAIN_MAIN = 'drill.chain.main';
export const CHAIN_SIDE = 'drill.chain.side';

const ACTOR: AuditActor = auditActor('drill-operator', 'operator', 'payout.approve');

function meta(id: string, at: string): EntryMeta {
  return { id, occurredAt: at };
}

export function seedJournal(): Journal {
  const large = money(GEL, 9_007_199_254_740_993_000n);
  const entries: readonly JournalEntry[] = [
    clientTopUp(meta('drill-e1-top-up', '2026-03-01T10:00:00.000Z'), BUYER, large),
    clientTopUp(meta('drill-e2-top-up', '2026-03-01T10:05:00.000Z'), SELLER, money(GEL, 5_000n)),
    lockForTranche(
      meta('drill-e3-lock', '2026-03-01T11:00:00.000Z'),
      BUYER,
      { dealId: DEAL, trancheId: TRANCHE },
      large,
    ),
    unlockToClientAccount(
      meta('drill-e4-unlock', '2026-03-01T12:00:00.000Z'),
      BUYER,
      { dealId: DEAL, trancheId: TRANCHE },
      large,
    ),
  ];
  return entries.reduce(appendEntry, emptyJournal);
}

const EVIDENCE = rawSourceRef({
  sourceKind: 'payment_provider_response',
  storageRef: 'documents/psp/2026/03/01/drill',
  mediaType: 'application/json',
  byteLength: 512,
  digest: 'b'.repeat(64),
  receivedAt: auditInstant(Date.UTC(2026, 2, 1, 10, 0, 0)),
  provider: 'psp.acme',
});

/** Цепочка из трёх записей: генезис, распоряжение о выплате и её исход. */
export function seedMainChain(): AuditChain {
  const genesis = genesisChain(CHAIN_MAIN, auditInstant(Date.UTC(2026, 2, 1, 9, 0, 0)), ACTOR);
  const ordered = appendRecord(genesis, {
    recordId: `${CHAIN_MAIN}:1`,
    recordedAt: auditInstant(Date.UTC(2026, 2, 1, 10, 0, 0)),
    actor: ACTOR,
    subject: auditRef('payout', 'drill-payout'),
    related: [auditRef('tranche', TRANCHE)],
    body: {
      kind: 'payout_ordered',
      idempotencyKey: 'idem.drill.payout',
      amount: auditAmount(GEL, 9_223_372_036_854_775_808n),
      beneficiary: auditFingerprint('account', 'c'.repeat(64)),
      policy: policyRef('payout/2026-01-01.1'),
      evidencePackage: [EVIDENCE],
    },
  });
  return appendRecord(ordered, {
    recordId: `${CHAIN_MAIN}:2`,
    recordedAt: auditInstant(Date.UTC(2026, 2, 1, 11, 0, 0)),
    actor: ACTOR,
    subject: auditRef('payout', 'drill-payout'),
    body: { kind: 'payout_result', outcome: 'settled', response: EVIDENCE, reasonKey: null },
  });
}

/** Вторая цепочка — чтобы сверка различала «цепочка не доехала» и «доехала не вся». */
export function seedSideChain(): AuditChain {
  return genesisChain(CHAIN_SIDE, auditInstant(Date.UTC(2026, 2, 1, 9, 30, 0)), ACTOR);
}

export interface Seeded {
  readonly journalEntries: number;
  readonly auditRecords: number;
}

/**
 * Заливка **с фиксацией**: копия снимается снаружи процесса, поэтому данные
 * обязаны быть видны другой сессии. Откатываемая транзакция, которой пользуются
 * наборы `@sdelka/db`, здесь не годится ничем.
 */
export async function seedSource(url: string): Promise<Seeded> {
  const pool = pooled(url);
  try {
    const client = await pool.connect();
    try {
      const journal = seedJournal();
      const main = seedMainChain();
      const side = seedSideChain();
      await client.query('BEGIN');
      await appendJournal(client, journal.entries);
      await appendAudit(client, main.records);
      await appendAudit(client, side.records);
      await client.query('COMMIT');
      return Object.freeze({
        journalEntries: journal.entries.length,
        auditRecords: main.records.length + side.records.length,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}
