import type { Instant } from '@sdelka/domain';
import {
  type Decision,
  type DetectorOutcome,
  type EvidenceRef,
  type PolicyVersionId,
  decision,
} from '../decision';
import { type IdentityDocument, identityKey } from '../identity';
import { type ReasonKey, REASON_KEYS } from '../keys';
import {
  type AccountFingerprint,
  type DeviceFingerprint,
  type NetworkAddressFingerprint,
  type PhoneFingerprint,
  fingerprintLabel,
} from '../pii';

/**
 * Совпадение устройства или реквизитов у формально независимых покупателей —
 * признак номинального владения (`PRODUCT.md` §10, `CCO-compliance.md`).
 *
 * Заявленное родство исключается из срабатывания: у супругов общий телефон и
 * общий счёт — норма, и без этого исключения детектор ловил бы половину
 * честных сделок вместо номиналов.
 *
 * **Одно лицо — не связанность** (`FUNCTIONAL.md` §2.1 «Что это ломает в уже
 * написанном», `ROADMAP.md` И6.4, крайний случай «клиент участвует в двух разных
 * сделках в обеих ролях»). Человек, продающий одну квартиру и покупающий другую,
 * приходит с одного устройства, с одного телефона и с одного счёта — иначе и не
 * бывает. До режима двух ролей это выглядело как два формально независимых
 * покупателя с общим кошельком, то есть ровно как схема.
 *
 * Признак различения — **ключ личности**, а не имя: имя по правилу пакета не
 * является достаточным основанием ни для чего, а латинизация необратима.
 * Поэтому `PartySignals` несёт документ, а не набор отпечатков «похожести».
 */
export const LINKAGE_SIGNAL_KINDS = ['account', 'device', 'network_address', 'phone'] as const;
export type LinkageSignalKind = (typeof LINKAGE_SIGNAL_KINDS)[number];

export interface PartySignals {
  readonly partyId: string;
  /**
   * Документ стороны. Поле обязательное: сигналы без личности сравнивать нельзя —
   * получится прежнее поведение, где одно лицо неотличимо от двух номиналов.
   */
  readonly identity: IdentityDocument;
  readonly accounts: readonly AccountFingerprint[];
  readonly devices: readonly DeviceFingerprint[];
  readonly networkAddresses: readonly NetworkAddressFingerprint[];
  readonly phones: readonly PhoneFingerprint[];
}

export interface SharedSignal {
  readonly kind: LinkageSignalKind;
  /** Короткая метка отпечатка. Сам отпечаток в отчёт не переносится. */
  readonly label: string;
}

export interface PartyLink {
  readonly partyIds: readonly [string, string];
  readonly shared: readonly SharedSignal[];
  /** Родство заявлено сторонами и подтверждено документами. */
  readonly declared: boolean;
  /**
   * Ключи личности сторон совпали — это одно лицо, а не две связанные стороны.
   * Сам ключ в отчёт не переносится: он содержит отпечаток номера документа, а в
   * `PartyLink` сегодня попадают только короткие метки (`fingerprintLabel`).
   */
  readonly sameIdentity: boolean;
}

export interface LinkageFacts {
  readonly parties: readonly PartySignals[];
  /** Пары сторон с заявленным и подтверждённым родством. */
  readonly declaredRelationships: readonly (readonly [string, string])[];
  readonly evidence: readonly EvidenceRef[];
}

export interface LinkageAssessment extends Decision<DetectorOutcome> {
  readonly links: readonly PartyLink[];
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function intersect(left: readonly string[], right: readonly string[]): readonly string[] {
  const set = new Set(right);
  return left.filter((item) => set.has(item));
}

export function findPartyLinks(facts: LinkageFacts): readonly PartyLink[] {
  const declared = new Set(facts.declaredRelationships.map(([a, b]) => pairKey(a, b)));
  const links: PartyLink[] = [];
  for (let i = 0; i < facts.parties.length; i += 1) {
    for (let j = i + 1; j < facts.parties.length; j += 1) {
      const left = facts.parties[i];
      const right = facts.parties[j];
      if (left === undefined || right === undefined) continue;
      const shared: SharedSignal[] = [];
      for (const value of intersect(left.accounts, right.accounts)) {
        shared.push(Object.freeze({ kind: 'account', label: fingerprintLabel(value) }));
      }
      for (const value of intersect(left.devices, right.devices)) {
        shared.push(Object.freeze({ kind: 'device', label: fingerprintLabel(value) }));
      }
      for (const value of intersect(left.networkAddresses, right.networkAddresses)) {
        shared.push(Object.freeze({ kind: 'network_address', label: fingerprintLabel(value) }));
      }
      for (const value of intersect(left.phones, right.phones)) {
        shared.push(Object.freeze({ kind: 'phone', label: fingerprintLabel(value) }));
      }
      if (shared.length === 0) continue;
      links.push(
        Object.freeze({
          partyIds: Object.freeze([left.partyId, right.partyId]) as readonly [string, string],
          shared: Object.freeze(shared),
          declared: declared.has(pairKey(left.partyId, right.partyId)),
          sameIdentity: identityKey(left.identity) === identityKey(right.identity),
        }),
      );
    }
  }
  return Object.freeze(links);
}

const SIGNAL_REASON: Readonly<Record<LinkageSignalKind, ReasonKey>> = Object.freeze({
  account: REASON_KEYS.linkageSharedAccount,
  device: REASON_KEYS.linkageSharedDevice,
  network_address: REASON_KEYS.linkageSharedNetworkAddress,
  phone: REASON_KEYS.linkageSharedPhone,
});

export function assessLinkage(
  facts: LinkageFacts,
  policy: PolicyVersionId,
  now: Instant,
): LinkageAssessment {
  const links = findPartyLinks(facts);
  // Совпадение ключа отсекается **до** фильтра заявленного родства: родственником
  // самому себе быть нельзя, и требовать документ о родстве с собой — абсурд,
  // который на практике превратился бы в отказ (`FUNCTIONAL.md` §2.1).
  const distinctPersons = links.filter((link) => !link.sameIdentity);
  const undeclared = distinctPersons.filter((link) => !link.declared);
  const reasons: ReasonKey[] = [];
  let outcome: DetectorOutcome = 'clear';
  for (const link of undeclared) {
    for (const signal of link.shared) {
      if (!reasons.includes(SIGNAL_REASON[signal.kind])) reasons.push(SIGNAL_REASON[signal.kind]);
      // Общий счёт у формально независимых покупателей — удержание: это уже
      // не совпадение обстановки, а общий кошелёк.
      outcome = signal.kind === 'account' ? 'hold' : outcome === 'hold' ? 'hold' : 'review';
    }
  }
  if (links.length > distinctPersons.length) reasons.push(REASON_KEYS.linkageSameIdentity);
  if (distinctPersons.length > undeclared.length) {
    reasons.push(REASON_KEYS.linkageDeclaredRelationship);
  }
  if (reasons.length === 0) reasons.push(REASON_KEYS.linkageNone);
  return Object.freeze({
    ...decision<DetectorOutcome>(outcome, policy, now, reasons, facts.evidence),
    links,
  });
}
