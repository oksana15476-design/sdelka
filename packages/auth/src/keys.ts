/**
 * Реестр ключей причин отказа.
 *
 * В пакете нет ни одной пользовательской строки: решение возвращает ключ, текст
 * живёт в словарях трёх языков (`CLAUDE.md` → «Три языка»). Ключи собраны в один
 * объект и выведены в тип `AuthReasonKey`, поэтому опечатка в причине не
 * собирается, а полнота словаря проверяется перебором значений.
 */
export const AUTH_REASON_KEYS = {
  /* --- Сессия --- */
  sessionExpired: 'auth.session.expired',
  sessionIdle: 'auth.session.idle',
  sessionRevoked: 'auth.session.revoked',
  sessionTtlTooLong: 'auth.session.ttl_too_long',

  /* --- Первичное подтверждение --- */
  primaryMethodNotAllowedForConsole: 'auth.primary.method_not_allowed_for_console',

  /* --- Второй фактор --- */
  secondFactorMissing: 'auth.second_factor.missing',
  secondFactorTooWeak: 'auth.second_factor.too_weak',
  secondFactorStale: 'auth.second_factor.stale',
  secondFactorChallengeMismatch: 'auth.second_factor.challenge_mismatch',
  secondFactorNotBound: 'auth.second_factor.not_bound',

  /* --- Полномочия --- */
  capabilityNotGranted: 'auth.capability.not_granted',
  capabilityHeldByNoRole: 'auth.capability.held_by_no_role',

  /* --- Дежурство --- */
  dutyRoleNotEligible: 'auth.duty.role_not_eligible',
  dutyDoesNotWiden: 'auth.duty.does_not_widen',

  /* --- Разделение обязанностей --- */
  sodPreparerCannotApprove: 'auth.sod.preparer_cannot_approve',
  sodObserverCannotApprove: 'auth.sod.observer_cannot_approve',
  sodApprovalLevelMissing: 'auth.sod.approval_level_missing',
  sodRequesterCannotApprove: 'auth.sod.requester_cannot_approve',
  sodCauserCannotLift: 'auth.sod.causer_cannot_lift',
  sodEconomicsExcludesMoney: 'auth.sod.economics_excludes_money',
  sodSelfApproval: 'auth.sod.self_approval',
  /**
   * Факт, по которому проверяется несовместимость, вызывающему неизвестен.
   *
   * Не то же самое, что «никто»: «никто» — это утверждение, за которое отвечает
   * вызывающий, а «неизвестно» — признание, что проверить нечем. Проверка, для
   * которой нет факта, не считается пройденной, поэтому это отказ.
   */
  sodContextUnknown: 'auth.sod.context_unknown',

  /* --- Кворум утверждений --- */
  quorumLevelOneMissing: 'auth.quorum.level_one_missing',
  quorumLevelTwoMissing: 'auth.quorum.level_two_missing',
  quorumApproversNotDistinct: 'auth.quorum.approvers_not_distinct',
  quorumTierNotOffered: 'auth.quorum.tier_not_offered',
  /** Ступень требует не 1 и не 2 подписи. Ноль сюда попадает первым. */
  quorumRequirementInvalid: 'auth.quorum.requirement_invalid',
  /** Кто готовил операцию — неизвестно. Н1 проверить нечем, кворум не берётся. */
  quorumPreparerUnknown: 'auth.quorum.preparer_unknown',

  /* --- Доказательство полномочия --- */
  /** Грант выписан слишком давно (или позже момента применения). */
  authorityStale: 'auth.authority.stale',

  /* --- Управление доступом --- */
  /** Действующая роль учётной записи вызывающему неизвестна. */
  accessCurrentRoleUnknown: 'auth.access.current_role_unknown',
  /** Переданное назначение относится к другой учётной записи или к другому человеку. */
  accessCurrentRoleMismatch: 'auth.access.current_role_mismatch',

  /* --- Реквизиты выплаты --- */
  beneficiaryValueDisclosedToNoRole: 'auth.beneficiary.value_disclosed_to_no_role',
} as const;

export type AuthReasonKey = (typeof AUTH_REASON_KEYS)[keyof typeof AUTH_REASON_KEYS];
