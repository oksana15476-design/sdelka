import { describe, expect, it } from 'vitest';
import type { CounterpartyFacts } from '@sdelka/compliance';
import { assessCounterparty, compareNames, identityKey, sameIdentity, selfDealingPairs } from '@sdelka/compliance';
import { dealStatusOf, trancheOptions } from '../src/index';
import {
  BUYER,
  BUYER_DOCUMENT,
  BUYER_DOCUMENT_AGAIN,
  BUYER_NAMES,
  NOW,
  POLICY_VERSION,
  SELLER_DOCUMENT,
  latinName,
  profile,
} from './support/fixtures';
import { openDeal } from './support/open';

const OPTIONS = trancheOptions(POLICY_VERSION);
const DEAL = 'deal-self-dealing';
const TRANCHE = 'tranche-self-dealing';

/**
 * Сценарий 8 — одна личность на обеих сторонах сделки.
 *
 * Продажа самому себе — известная схема перемещения денег с видимостью
 * основания (`FUNCTIONAL.md` §2.1, `ROADMAP.md` И6.4). Исход `block`, а не
 * `review`: это отказ, а не предупреждение и не задача оператору.
 */
describe('одна личность на обеих сторонах', () => {
  it('отказывает в заведении сделки и не пускает к ней ни одной копейки', async () => {
    // Тот же документ, другой профиль стороны: ключ личности совпадает.
    const sameHuman = profile('party-seller-alias', BUYER_DOCUMENT_AGAIN, [
      // Имя записано иначе — и это не имеет значения: сверка идёт по документу.
      latinName('Sabo', 'Tikatho'),
    ]);
    expect(sameIdentity(BUYER_DOCUMENT, sameHuman.document)).toBe(true);
    expect(identityKey(BUYER_DOCUMENT)).toBe(identityKey(sameHuman.document));

    const opened = await openDeal({
      dealId: DEAL,
      trancheId: TRANCHE,
      buyer: BUYER,
      seller: sameHuman,
    });

    expect(opened.admission).toBe('block');
    const world = opened.world;

    // Ни транша, ни проводок: деньги к этой сделке не подпускаются вовсе.
    expect(world.tranches.size).toBe(0);
    expect(world.journal.entries).toHaveLength(0);
    // Отмена возможна именно потому, что денег не было (§3.1).
    expect(dealStatusOf(world, DEAL)).toBe('cancelled');

    // Отказ записан в журнал аудита с причиной и версией политики.
    const decisions = world.chain.records.filter((item) => item.body.kind === 'decision_made');
    const blocked = decisions.find(
      (item) => item.body.kind === 'decision_made' && item.body.outcomeKey === 'block',
    );
    expect(blocked).toBeDefined();
    if (blocked !== undefined && blocked.body.kind === 'decision_made') {
      expect(blocked.body.reasonKeys).toContain('compliance.counterparty.same_identity');
      expect(blocked.body.policy).toBe(POLICY_VERSION as unknown as string);
    }

    // Пара, из-за которой отказано, называется поимённо — сторонами, а не
    // ключами: ключ несёт отпечаток номера документа.
    const pairs = selfDealingPairs([
      { partyId: BUYER.partyId, role: 'payer', document: BUYER.document },
      { partyId: sameHuman.partyId, role: 'recipient', document: sameHuman.document },
    ]);
    expect(pairs).toEqual([[BUYER.partyId, sameHuman.partyId]]);

    // Обратный случай: имена совпали, ключи — нет. Это **не** отказ, потому что
    // совпадение имени не является достаточным основанием ни для чего.
    const namesakeFacts: CounterpartyFacts = {
      participations: [
        { partyId: 'party-a', role: 'payer', document: BUYER_DOCUMENT },
        { partyId: 'party-b', role: 'recipient', document: SELLER_DOCUMENT },
      ],
      relation: { kind: 'unrelated' },
      nameMatch: compareNames(BUYER_NAMES, BUYER_NAMES, { strongThresholdBp: 9_500 }),
      evidence: [],
    };
    const namesake = assessCounterparty(namesakeFacts, POLICY_VERSION, NOW);
    expect(namesake.outcome).toBe('clear');
    expect(namesake.reasons).toContain('compliance.counterparty.name_match_is_not_identity');
    expect(OPTIONS.policy).toBe(POLICY_VERSION);
    expect(NOW).toBeGreaterThan(0);
  });
});
