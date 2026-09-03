import { describe, expect, it } from 'vitest';
import {
  type TrancheEvent,
  type TrancheState,
  PAYOUT_NAMESPACE,
  UUID_NAMESPACE_DNS,
  UUID_NAMESPACE_URL,
  applyCommand,
  emptyCommandJournal,
  payoutIdempotencyKey,
  reduceTranche,
  uuid5,
} from '../src/index';
import { AMOUNT, context } from './support/facts';
import { stateAt } from './support/drive';

describe('uuid5 собственной реализации', () => {
  it('matches the RFC 4122 vectors', () => {
    expect(uuid5(UUID_NAMESPACE_DNS, 'example.com')).toBe('cfbff0d1-9375-5685-968c-48ce8b15ae17');
    expect(uuid5(UUID_NAMESPACE_DNS, 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
    expect(uuid5(UUID_NAMESPACE_URL, 'https://sdelka.example/ns/payout')).toBe(
      'ede3429d-450e-5390-ba3b-bf680b733b27',
    );
  });

  it('sets version 5 and the RFC variant bits', () => {
    const value = uuid5(PAYOUT_NAMESPACE, 'tranche-1');
    expect(value[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(value[19]);
  });

  it('rejects a malformed namespace', () => {
    expect(() => uuid5('not-a-uuid', 'x')).toThrow();
  });
});

describe('детерминированный ключ выплаты', () => {
  it('depends on the tranche only', () => {
    expect(payoutIdempotencyKey('tranche-1')).toBe('e6f4e135-a0f5-5781-9137-596421a8d0e7');
    expect(payoutIdempotencyKey('tranche-1')).toBe(payoutIdempotencyKey('tranche-1'));
    expect(payoutIdempotencyKey('tranche-2')).not.toBe(payoutIdempotencyKey('tranche-1'));
  });

  it('takes exactly one argument, so an attempt number cannot leak into it', () => {
    expect(payoutIdempotencyKey.length).toBe(1);
  });
});

describe('журнал команд: повтор не двигает состояние дважды', () => {
  const fundsReceived: TrancheEvent = {
    type: 'funds_received',
    amount: AMOUNT,
    sender: 'buyer-1',
    reference: 'ref-1',
  };

  it('replays a known command key without changing the state or emitting intents again', () => {
    const ctx = context();
    const journal = emptyCommandJournal<TrancheState>();
    const first = applyCommand(reduceTranche, journal, stateAt('collecting'), 'cmd-1', fundsReceived, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state.status).toBe('collected');
    expect(first.value.replayed).toBe(false);
    expect(first.value.intents.length).toBeGreaterThan(0);

    // Тот же ключ, то же событие: банк повторил вебхук.
    const second = applyCommand(
      reduceTranche,
      first.value.journal,
      first.value.state,
      'cmd-1',
      fundsReceived,
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.replayed).toBe(true);
    expect(second.value.state).toEqual(first.value.state);
    // Ни одной повторной проводки и ни одного повторного поручения.
    expect(second.value.intents).toEqual([]);
  });

  it('lets a different key move the state further', () => {
    const ctx = context();
    const first = applyCommand(
      reduceTranche,
      emptyCommandJournal<TrancheState>(),
      stateAt('collecting'),
      'cmd-1',
      fundsReceived,
      ctx,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyCommand(
      reduceTranche,
      first.value.journal,
      first.value.state,
      'cmd-2',
      { type: 'reserve_requested' },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.state.status).toBe('reserved');
    expect(second.value.journal.applied.size).toBe(2);
  });

  it('does not record a rejected command', () => {
    const ctx = context();
    const result = applyCommand(
      reduceTranche,
      emptyCommandJournal<TrancheState>(),
      stateAt('collecting'),
      'cmd-1',
      { type: 'reserve_requested' },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});
