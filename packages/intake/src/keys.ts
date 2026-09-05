/**
 * Реестр ключей локализации приёма.
 *
 * В пакете нет ни одной пользовательской строки: результат несёт ключ, текст
 * живёт в словарях трёх языков (`CLAUDE.md` → «Три языка»). Собраны в один
 * объект и выведены в тип, поэтому опечатка не собирается, а полнота словаря
 * проверяется перебором значений, а не поиском по коду — тот же приём, что в
 * `@sdelka/compliance`.
 */
export const INTAKE_REASON_KEYS = {
  /* --- Допуск --- */
  toleranceNotDisclosed: 'intake.tolerance.not_disclosed',
  toleranceDisclosedAfterPayment: 'intake.tolerance.disclosed_after_payment',
  toleranceDisclosureStale: 'intake.tolerance.disclosure_stale',
  toleranceDisclosureOlderPolicy: 'intake.tolerance.disclosure_older_policy',
  toleranceCurrencyNotDeclared: 'intake.tolerance.currency_not_declared',
  toleranceApplied: 'intake.tolerance.applied',
  toleranceZero: 'intake.tolerance.zero',

  /* --- Причина недостачи --- */
  shortfallCauseCorrespondent: 'intake.shortfall.cause_correspondent',
  shortfallCausePayer: 'intake.shortfall.cause_payer',
  shortfallCauseUnknown: 'intake.shortfall.cause_unknown',
  shortfallAwaitsTopUp: 'intake.shortfall.awaits_top_up',

  /* --- Разнесение поступления --- */
  allocationExact: 'intake.allocation.exact',
  allocationOverpayment: 'intake.allocation.overpayment',
  allocationShortfallAbsorbed: 'intake.allocation.shortfall_absorbed',
  allocationInsufficient: 'intake.allocation.insufficient',
  allocationWrongCurrency: 'intake.allocation.wrong_currency',
  allocationAccumulating: 'intake.allocation.accumulating',

  /* --- Референс --- */
  referenceExact: 'intake.reference.exact',
  referenceDamaged: 'intake.reference.damaged',
  referenceAbsent: 'intake.reference.absent',
  referenceChecksumFailed: 'intake.reference.checksum_failed',

  /* --- Сопоставление --- */
  matchAuto: 'intake.match.auto',
  matchAmbiguous: 'intake.match.ambiguous',
  matchNoCandidate: 'intake.match.no_candidate',
  matchNameSecondaryOnly: 'intake.match.name_secondary_only',
  matchSourceAccountSeen: 'intake.match.source_account_seen',
  matchManualAwaitsSecondApproval: 'intake.match.manual_awaits_second_approval',
  matchManualJustificationMissing: 'intake.match.manual_justification_missing',

  /* --- Маршрут приёма --- */
  routeToClientAccount: 'intake.route.to_client_account',
  routeToSuspense: 'intake.route.to_suspense',
  routePayerHold: 'intake.route.payer_hold',

  /* --- Котировка --- */
  quoteFirm: 'intake.quote.firm',
  quoteVoidedByMarketMove: 'intake.quote.voided_by_market_move',
  quoteExpired: 'intake.quote.expired',
  quoteConfirmationMissing: 'intake.quote.confirmation_missing',
  quoteConfirmationForOtherQuote: 'intake.quote.confirmation_for_other_quote',
  quoteMarkupDisclosed: 'intake.quote.markup_disclosed',

  /* --- Трекинг --- */
  trackingLegObserved: 'intake.tracking.leg_observed',
  trackingLegDeclared: 'intake.tracking.leg_declared',
  trackingLegNotObservable: 'intake.tracking.leg_not_observable',
  trackingOverdue: 'intake.tracking.overdue',
} as const;

export type IntakeReasonKey = (typeof INTAKE_REASON_KEYS)[keyof typeof INTAKE_REASON_KEYS];

export const ALL_INTAKE_REASON_KEYS: readonly IntakeReasonKey[] = Object.freeze(
  Object.values(INTAKE_REASON_KEYS),
);
