/** Технические ключи ошибок для разработчика. Не пользовательский текст. */
export const LedgerErrorCode = {
  accountInvalidIdentifier: 'ledger.account.invalid_identifier',
  entryTooFewPostings: 'ledger.entry.too_few_postings',
  entryUnbalanced: 'ledger.entry.unbalanced',
  entryFeeIntoClientFunds: 'ledger.entry.fee_into_client_funds',
  entryClientFundsCrossSubsidy: 'ledger.entry.client_funds_cross_subsidy',
  entryLockedToLocked: 'ledger.entry.locked_to_locked',
  entryClientOwnerMismatch: 'ledger.entry.client_owner_mismatch',
  entryPlatformIncomeNotSwept: 'ledger.entry.platform_income_not_swept',
  entrySettlementShapeMismatch: 'ledger.entry.settlement_shape_mismatch',
  entryObligationIntoSuspense: 'ledger.entry.obligation_into_suspense',
  settlementSelfDealing: 'ledger.settlement.self_dealing',
  entryNonPositiveExcess: 'ledger.entry.non_positive_excess',
  entryCorrectionWithoutReference: 'ledger.entry.correction_without_reference',
  entrySettlementWithReference: 'ledger.entry.settlement_with_reference',
  postingNonPositiveAmount: 'ledger.posting.non_positive_amount',
  postingCustodyWithoutAttribution: 'ledger.posting.custody_without_attribution',
  postingAttributionMismatch: 'ledger.posting.attribution_mismatch',
  postingClientAttributionMismatch: 'ledger.posting.client_attribution_mismatch',
  journalDuplicateEntryId: 'ledger.journal.duplicate_entry_id',
} as const;

export type LedgerErrorCode = (typeof LedgerErrorCode)[keyof typeof LedgerErrorCode];

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: LedgerErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}
