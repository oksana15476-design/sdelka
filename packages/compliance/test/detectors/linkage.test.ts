import { describe, expect, it } from 'vitest';
import { type LinkageFacts, type PartySignals, assessLinkage } from '../../src/index';
import {
  ACCOUNT_OTHER,
  ACCOUNT_SOURCE,
  ACCOUNT_THIRD,
  ADDRESS_SHARED,
  BUYER_DOCUMENT,
  DEVICE_SHARED,
  document,
  evidence,
  NOW,
  PHONE_SHARED,
  POLICY_VERSION,
  SAME_PERSON_DOCUMENT,
} from '../support/fixtures';

/**
 * По умолчанию у каждой стороны **свой** документ: иначе кейсы «общее устройство»
 * и «общий счёт» описывали бы одно лицо и обязаны были бы возвращать `clear`.
 * Совпадающий ключ передаётся явно там, где кейс именно про одно лицо.
 */
const DOCUMENTS: Readonly<Record<string, ReturnType<typeof document>>> = {
  a: BUYER_DOCUMENT,
  b: document(31),
  c: document(32),
};

function party(partyId: string, overrides: Partial<PartySignals> = {}): PartySignals {
  return {
    partyId,
    identity: DOCUMENTS[partyId] ?? document(39),
    accounts: [],
    devices: [],
    networkAddresses: [],
    phones: [],
    ...overrides,
  };
}

const assess = (facts: Partial<LinkageFacts>) =>
  assessLinkage(
    { parties: [], declaredRelationships: [], evidence: [evidence(1)], ...facts },
    POLICY_VERSION,
    NOW,
  );

describe('совпадение устройства и реквизитов у независимых покупателей', () => {
  it('не срабатывает при отсутствии общих сигналов', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { accounts: [ACCOUNT_OTHER] }),
      ],
    });
    expect(result.outcome).toBe('clear');
    expect(result.links).toHaveLength(0);
    expect(result.reasons).toContain('compliance.linkage.none');
  });

  it('общее устройство — задача в очередь', () => {
    const result = assess({
      parties: [party('a', { devices: [DEVICE_SHARED] }), party('b', { devices: [DEVICE_SHARED] })],
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.linkage.shared_device');
    expect(result.links[0]?.partyIds).toEqual(['a', 'b']);
  });

  it('общий сетевой адрес и телефон — задача в очередь', () => {
    const result = assess({
      parties: [
        party('a', { networkAddresses: [ADDRESS_SHARED], phones: [PHONE_SHARED] }),
        party('b', { networkAddresses: [ADDRESS_SHARED], phones: [PHONE_SHARED] }),
      ],
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.linkage.shared_network_address');
    expect(result.reasons).toContain('compliance.linkage.shared_phone');
  });

  it('общий счёт — удержание, а не задача', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { accounts: [ACCOUNT_SOURCE] }),
      ],
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.linkage.shared_account');
  });

  it('общий счёт вместе с общим устройством остаётся удержанием', () => {
    // Сигналы разбираются подряд, и найденный следом за счётом более слабый
    // сигнал не должен понижать исход: общий кошелёк остаётся общим кошельком,
    // сколько бы совпадений обстановки к нему ни добавилось.
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE], devices: [DEVICE_SHARED] }),
        party('b', { accounts: [ACCOUNT_SOURCE], devices: [DEVICE_SHARED] }),
      ],
    });
    expect(result.outcome).toBe('hold');
    expect(result.reasons).toContain('compliance.linkage.shared_account');
    expect(result.reasons).toContain('compliance.linkage.shared_device');
  });

  it('заявленное и подтверждённое родство исключается из срабатывания', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE], phones: [PHONE_SHARED] }),
        party('b', { accounts: [ACCOUNT_SOURCE], phones: [PHONE_SHARED] }),
      ],
      declaredRelationships: [['a', 'b']],
    });
    expect(result.outcome).toBe('clear');
    expect(result.links[0]?.declared).toBe(true);
    expect(result.reasons).toContain('compliance.linkage.declared_relationship');
  });

  it('одно лицо в двух ролях — не связанность: общий счёт не удерживает', () => {
    // `FUNCTIONAL.md` §2.1, `ROADMAP.md` И6.4 (крайний случай): человек продаёт
    // одну квартиру и покупает другую. Счёт, устройство и телефон у него одни.
    const result = assess({
      parties: [
        party('a', {
          accounts: [ACCOUNT_SOURCE],
          devices: [DEVICE_SHARED],
          phones: [PHONE_SHARED],
        }),
        party('b', {
          identity: SAME_PERSON_DOCUMENT,
          accounts: [ACCOUNT_SOURCE],
          devices: [DEVICE_SHARED],
          phones: [PHONE_SHARED],
        }),
      ],
    });
    expect(result.outcome).toBe('clear');
    expect(result.links[0]?.sameIdentity).toBe(true);
    expect(result.reasons).toContain('compliance.linkage.same_identity');
    expect(result.reasons).not.toContain('compliance.linkage.shared_account');
  });

  it('одно лицо не требует заявленного родства с самим собой', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { identity: SAME_PERSON_DOCUMENT, accounts: [ACCOUNT_SOURCE] }),
      ],
      declaredRelationships: [],
    });
    expect(result.outcome).toBe('clear');
    expect(result.reasons).not.toContain('compliance.linkage.declared_relationship');
  });

  it('те же сигналы при разных ключах личности удерживают по-прежнему', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE] }),
        party('b', { accounts: [ACCOUNT_SOURCE] }),
      ],
    });
    expect(result.outcome).toBe('hold');
    expect(result.links[0]?.sameIdentity).toBe(false);
    expect(result.reasons).toContain('compliance.linkage.shared_account');
  });

  it('совпадение ключа у пары не глушит связанность третьей стороны', () => {
    const result = assess({
      parties: [
        party('a', { accounts: [ACCOUNT_SOURCE], devices: [DEVICE_SHARED] }),
        party('b', { identity: SAME_PERSON_DOCUMENT, accounts: [ACCOUNT_SOURCE] }),
        party('c', { accounts: [ACCOUNT_THIRD], devices: [DEVICE_SHARED] }),
      ],
    });
    expect(result.outcome).toBe('review');
    expect(result.reasons).toContain('compliance.linkage.same_identity');
    expect(result.reasons).toContain('compliance.linkage.shared_device');
    expect(result.reasons).not.toContain('compliance.linkage.shared_account');
  });

  it('«связей нет» не приписывается там, где связь найдена', () => {
    // Причина-заглушка ставится только вместо пустого перечня. Иначе отчёт
    // одновременно называет связь и отрицает её, и оператор читает оба.
    const result = assess({
      parties: [party('a', { devices: [DEVICE_SHARED] }), party('b', { devices: [DEVICE_SHARED] })],
    });
    expect(result.reasons).toContain('compliance.linkage.shared_device');
    expect(result.reasons).not.toContain('compliance.linkage.none');
  });

  it('в отчёт попадает метка отпечатка, а не сам отпечаток', () => {
    const result = assess({
      parties: [party('a', { devices: [DEVICE_SHARED] }), party('b', { devices: [DEVICE_SHARED] })],
    });
    const label = result.links[0]?.shared[0]?.label ?? '';
    expect(label).toHaveLength(8);
    expect(JSON.stringify(result.links)).not.toContain(DEVICE_SHARED);
    // Ключ личности считается внутри и в отчёт не переносится: он несёт
    // отпечаток номера документа, а в `PartyLink` попадают только метки.
    expect(JSON.stringify(result.links)).not.toContain(BUYER_DOCUMENT.numberFingerprint);
  });
});
