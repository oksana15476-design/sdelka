/**
 * Реестр ключей локализации комплаенса.
 *
 * В пакете нет ни одной пользовательской строки: решение возвращает ключ, текст
 * живёт в словарях трёх языков (`CLAUDE.md` → «Три языка»). Ключи собраны в один
 * объект и выведены в тип `ReasonKey`, поэтому опечатка в причине не собирается,
 * а полнота словаря проверяется перебором значений, а не поиском по коду.
 */
export const REASON_KEYS = {
  /* --- Идентификация --- */
  identityDocumentMissing: 'compliance.identity.document_missing',
  identityDocumentExpired: 'compliance.identity.document_expired',
  identityLatinNameMissing: 'compliance.identity.latin_name_missing',
  identityGeorgianPersonalNumberAbsent: 'compliance.identity.georgian_personal_number_absent',
  identityKeysDiffer: 'compliance.identity.keys_differ',

  /* --- Имена --- */
  nameNotComparable: 'compliance.name.not_comparable',
  nameLatinizationIrreversible: 'compliance.name.latinization_irreversible',
  nameCyrillicMoreAmbiguous: 'compliance.name.cyrillic_more_ambiguous',
  nameEvidenceInsufficientAlone: 'compliance.name.evidence_insufficient_alone',

  /* --- Сверка собственника --- */
  ownerDocumentNumberMatched: 'compliance.owner.document_number_matched',
  ownerDocumentNumberMissing: 'compliance.owner.document_number_missing',
  ownerDocumentNumberMismatch: 'compliance.owner.document_number_mismatch',
  ownerNameSecondarySignalOnly: 'compliance.owner.name_secondary_signal_only',

  /* --- Плательщик --- */
  payerSelf: 'compliance.payer.self',
  payerThirdPartyHold: 'compliance.payer.third_party_hold',
  payerRelationshipUnknown: 'compliance.payer.relationship_unknown',
  payerKinshipProofMissing: 'compliance.payer.kinship_proof_missing',
  payerKycIncomplete: 'compliance.payer.kyc_incomplete',
  payerOwnershipBelowThreshold: 'compliance.payer.ownership_below_threshold',
  payerExceptionApplied: 'compliance.payer.exception_applied',
  payerIntermediaryBlocked: 'compliance.payer.intermediary_blocked',
  payerExchangeBlocked: 'compliance.payer.exchange_blocked',
  payerLawFirmBlocked: 'compliance.payer.law_firm_blocked',
  payerNameMatchIsNotIdentity: 'compliance.payer.name_match_is_not_identity',
  payerInternalOwnBalance: 'compliance.payer.internal_own_balance',

  /* --- Возврат --- */
  refundSourceAccountUnknown: 'compliance.refund.source_account_unknown',
  refundAccountDiffers: 'compliance.refund.account_differs',
  refundHolderDiffers: 'compliance.refund.holder_differs',
  refundSanctionsFreezePrecedence: 'compliance.refund.sanctions_freeze_precedence',
  refundToSourceAccount: 'compliance.refund.to_source_account',

  /* --- Цена --- */
  priceMatchesContract: 'compliance.price.matches_contract',
  priceBelowContract: 'compliance.price.below_contract',
  priceAboveContract: 'compliance.price.above_contract',
  priceCurrencyMismatch: 'compliance.price.currency_mismatch',
  priceContractMissing: 'compliance.price.contract_missing',
  priceSecondAmountRequested: 'compliance.price.second_amount_requested',
  priceSuspicionAssessmentRequired: 'compliance.price.suspicion_assessment_required',

  /* --- Разбиение платежа --- */
  structuringNoPattern: 'compliance.structuring.no_pattern',
  structuringPatternDetected: 'compliance.structuring.pattern_detected',

  /* --- Связанность сторон --- */
  linkageNone: 'compliance.linkage.none',
  linkageSharedAccount: 'compliance.linkage.shared_account',
  linkageSharedDevice: 'compliance.linkage.shared_device',
  linkageSharedNetworkAddress: 'compliance.linkage.shared_network_address',
  linkageSharedPhone: 'compliance.linkage.shared_phone',
  linkageDeclaredRelationship: 'compliance.linkage.declared_relationship',
  linkageSameIdentity: 'compliance.linkage.same_identity',

  /* --- Одна личность на обеих сторонах сделки --- */
  counterpartySameIdentity: 'compliance.counterparty.same_identity',
  counterpartyRelatedParties: 'compliance.counterparty.related_parties',
  counterpartyDistinct: 'compliance.counterparty.distinct',
  counterpartyNameMatchIsNotIdentity: 'compliance.counterparty.name_match_is_not_identity',

  /* --- Быстрая перепродажа --- */
  flippingNone: 'compliance.flipping.none',
  flippingRecentTransfer: 'compliance.flipping.recent_transfer',
  flippingPriceJump: 'compliance.flipping.price_jump',

  /* --- Санкции --- */
  sanctionsNoCandidates: 'compliance.sanctions.no_candidates',
  sanctionsPossibleMatch: 'compliance.sanctions.possible_match',
  sanctionsConfirmedMatch: 'compliance.sanctions.confirmed_match',
  sanctionsProviderUnavailable: 'compliance.sanctions.provider_unavailable',
  sanctionsBelowThreshold: 'compliance.sanctions.below_threshold',
  sanctionsWhitelistSuppressed: 'compliance.sanctions.whitelist_suppressed',
  sanctionsWhitelistExpired: 'compliance.sanctions.whitelist_expired',
  sanctionsWhitelistStaleEntryVersion: 'compliance.sanctions.whitelist_stale_entry_version',
  sanctionsGeorgianCarveOutDisapplied: 'compliance.sanctions.georgian_carve_out_disapplied',
  sanctionsListNotCovered: 'compliance.sanctions.list_not_covered',

  /* --- Реквизиты выплаты --- */
  beneficiaryHolderNameMismatch: 'compliance.beneficiary.holder_name_mismatch',
  beneficiaryHolderNameConsistent: 'compliance.beneficiary.holder_name_consistent',
  beneficiaryLatinNameRequired: 'compliance.beneficiary.latin_name_required',
  beneficiaryOwnershipEvidenceMissing: 'compliance.beneficiary.ownership_evidence_missing',
  beneficiaryChangeInReleaseWindow: 'compliance.beneficiary.change_in_release_window',
  beneficiaryChangeCoolingOff: 'compliance.beneficiary.change_cooling_off',
  beneficiaryChangeAwaitsSecondApproval: 'compliance.beneficiary.change_awaits_second_approval',
  beneficiaryChangeApproverNotDistinct: 'compliance.beneficiary.change_approver_not_distinct',
  beneficiaryChangeReverificationMissing: 'compliance.beneficiary.change_reverification_missing',
  beneficiaryChangeApplied: 'compliance.beneficiary.change_applied',
  beneficiaryLocked: 'compliance.beneficiary.locked',

  /* --- Концентрация --- */
  concentrationWithinLimits: 'compliance.concentration.within_limits',
  concentrationCountryExceeded: 'compliance.concentration.country_exceeded',
  concentrationHighRiskCountryExceeded: 'compliance.concentration.high_risk_country_exceeded',
  concentrationHighRiskAggregateExceeded: 'compliance.concentration.high_risk_aggregate_exceeded',

  /* --- Второе утверждение (общий примитив) --- */
  dualControlAwaitsSecondApproval: 'compliance.dual_control.awaits_second_approval',
  dualControlApproverNotDistinct: 'compliance.dual_control.approver_not_distinct',

  /* --- Очередь разбора --- */
  queueEscalated: 'compliance.queue.escalated',

  /* --- Роли --- */
  roleCapabilityDenied: 'compliance.role.capability_denied',
  roleImpersonationExpired: 'compliance.role.impersonation_expired',
  roleImpersonationConsentMissing: 'compliance.role.impersonation_consent_missing',

  /* --- Уровень проверки --- */
  verificationLevelEnhanced: 'compliance.verification.level_enhanced',
  verificationHighRiskNationality: 'compliance.verification.high_risk_nationality',
} as const;

export type ReasonKey = (typeof REASON_KEYS)[keyof typeof REASON_KEYS];

export const ALL_REASON_KEYS: readonly ReasonKey[] = Object.freeze(Object.values(REASON_KEYS));
