import { type Instant, type Result, failure, ok } from '@sdelka/domain';
import { ComplianceError, ComplianceErrorCode } from './errors';
import type { CountryCode, KycStatus, PartyKind, PartyProfile } from './identity';
import { type ReasonKey, REASON_KEYS } from './keys';
import type { NameDigest } from './pii';
import { nameDigest } from './pii';

/**
 * Роли и полномочия — `CORE.md` Ф12, `BACKLOG.md` E6-8, E4-11.
 *
 * Ограничения поддержки выражены **типами**: полномочие — параметр типа роли, и
 * `authorize(support, 'write_beneficiary')` не компилируется, потому что такого
 * члена нет в объединении полномочий поддержки. Проверка в рантайме оставлена
 * как второй рубеж: типы не переживают границу процесса, роль приходит из базы.
 */
export const CAPABILITIES = [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'write_beneficiary',
  'approve_beneficiary_change',
  'approve_payout',
  'lift_block',
  'run_screening',
  'adjudicate_screening',
  'act_on_behalf',
  'confirm_test_transfer_code',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type RoleId =
  | 'operator'
  | 'approver'
  | 'compliance_analyst'
  | 'support'
  | 'representative'
  | 'client';

export interface Role<C extends Capability> {
  readonly id: RoleId;
  readonly capabilities: readonly C[];
}

function role<C extends Capability>(id: RoleId, capabilities: readonly C[]): Role<C> {
  return Object.freeze({ id, capabilities: Object.freeze([...capabilities]) });
}

/**
 * Поддержка: read-only по умолчанию. Реквизитов выплаты нет в перечне ни на
 * чтение, ни на запись; утверждения выплат нет; снятия блокировок нет.
 */
export type SupportCapability = 'read_deal' | 'read_party' | 'act_on_behalf';
export const SUPPORT_ROLE: Role<SupportCapability> = role('support', [
  'read_deal',
  'read_party',
  'act_on_behalf',
]);

export type OperatorCapability =
  | 'read_deal'
  | 'read_party'
  | 'read_beneficiary'
  | 'write_beneficiary'
  | 'run_screening';
export const OPERATOR_ROLE: Role<OperatorCapability> = role('operator', [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'write_beneficiary',
  'run_screening',
]);

export type ApproverCapability =
  | 'read_deal'
  | 'read_party'
  | 'read_beneficiary'
  | 'approve_beneficiary_change'
  | 'approve_payout';
export const APPROVER_ROLE: Role<ApproverCapability> = role('approver', [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'approve_beneficiary_change',
  'approve_payout',
]);

export type AnalystCapability =
  | 'read_deal'
  | 'read_party'
  | 'read_beneficiary'
  | 'run_screening'
  | 'adjudicate_screening'
  | 'lift_block';
export const ANALYST_ROLE: Role<AnalystCapability> = role('compliance_analyst', [
  'read_deal',
  'read_party',
  'read_beneficiary',
  'run_screening',
  'adjudicate_screening',
  'lift_block',
]);

/**
 * Представитель по доверенности. Сегмент вне страны, доверенности будут.
 * Реквизиты не меняет и код тестового перевода не подтверждает — иначе
 * доверенность обходит весь периметр защиты реквизитов (`CORE.md` §3).
 */
export type RepresentativeCapability = 'read_deal' | 'read_party';
export const REPRESENTATIVE_ROLE: Role<RepresentativeCapability> = role('representative', [
  'read_deal',
  'read_party',
]);

export type ClientCapability = 'read_deal' | 'write_beneficiary' | 'confirm_test_transfer_code';
export const CLIENT_ROLE: Role<ClientCapability> = role('client', [
  'read_deal',
  'write_beneficiary',
  'confirm_test_transfer_code',
]);

export interface Actor<C extends Capability> {
  readonly actorId: string;
  readonly role: Role<C>;
}

export function actor<C extends Capability>(actorId: string, actorRole: Role<C>): Actor<C> {
  return Object.freeze({ actorId, role: actorRole });
}

/**
 * Доказательство полномочия. Функции, меняющие периметр, принимают его, а не
 * актора: подделать нельзя, не выписав, а выписать нельзя без роли, в которой
 * это полномочие объявлено.
 */
export interface Authority<C extends Capability> {
  readonly actorId: string;
  readonly roleId: RoleId;
  readonly capability: C;
}

export function authorize<C extends Capability, G extends C>(
  subject: Actor<C>,
  capability: G,
): Authority<G> {
  if (!(subject.role.capabilities as readonly Capability[]).includes(capability)) {
    throw new ComplianceError(ComplianceErrorCode.capabilityNotGranted, {
      roleId: subject.role.id,
      capability,
    });
  }
  return Object.freeze({ actorId: subject.actorId, roleId: subject.role.id, capability });
}

/* ------------------------------------------------------------------------- */
/* Маскирование для поддержки                                                */
/* ------------------------------------------------------------------------- */

/**
 * Проекция профиля для поддержки. Отпечатка документа и личного номера в ней
 * нет как полей, имена — только в виде дайджеста. Скрыть нечего, потому что
 * нечего показать: ограничение проходит по типу, а не по фильтру в шаблоне.
 */
export interface SupportPartyView {
  readonly partyId: string;
  readonly kind: PartyKind;
  readonly residenceCountry: CountryCode;
  readonly nationalities: readonly CountryCode[];
  readonly kyc: KycStatus;
  readonly names: readonly NameDigest[];
}

export function supportPartyView(
  profile: PartyProfile,
  _authority: Authority<'read_party'>,
): SupportPartyView {
  return Object.freeze({
    partyId: profile.partyId,
    kind: profile.kind,
    residenceCountry: profile.residenceCountry,
    nationalities: Object.freeze([...profile.nationalities]),
    kyc: profile.kyc,
    names: Object.freeze(
      profile.names.map((observation) =>
        nameDigest(observation.alphabet, observation.given, observation.family),
      ),
    ),
  });
}

/* ------------------------------------------------------------------------- */
/* Работа от имени клиента                                                   */
/* ------------------------------------------------------------------------- */

/** Короткий срок — часть определения, а не настройка: 30 минут. */
export const MAX_IMPERSONATION_TTL_MS = 30 * 60 * 1000;

export interface ImpersonationGrant {
  readonly grantId: string;
  readonly actorId: string;
  readonly partyId: string;
  /** Ссылка на согласие клиента. Без неё сессия не выдаётся. */
  readonly consentRef: string;
  readonly grantedAt: Instant;
  readonly expiresAt: Instant;
}

export interface ImpersonationRequest {
  readonly grantId: string;
  readonly partyId: string;
  readonly consentRef: string | null;
  readonly ttlMs: number;
}

export function grantImpersonation(
  authority: Authority<'act_on_behalf'>,
  request: ImpersonationRequest,
  now: Instant,
): Result<ImpersonationGrant, ReasonKey> {
  if (request.consentRef === null || request.consentRef === '') {
    return failure(REASON_KEYS.roleImpersonationConsentMissing);
  }
  const ttl = Math.min(request.ttlMs, MAX_IMPERSONATION_TTL_MS);
  if (ttl <= 0) {
    return failure(REASON_KEYS.roleImpersonationExpired);
  }
  return ok(
    Object.freeze({
      grantId: request.grantId,
      actorId: authority.actorId,
      partyId: request.partyId,
      consentRef: request.consentRef,
      grantedAt: now,
      expiresAt: (now + ttl) as Instant,
    }),
  );
}

export function isImpersonationValid(grant: ImpersonationGrant, now: Instant): boolean {
  return now < grant.expiresAt;
}
