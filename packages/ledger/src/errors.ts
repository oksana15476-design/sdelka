/** Технические ключи ошибок для разработчика. Не пользовательский текст. */
export const LedgerErrorCode = {
  accountInvalidIdentifier: 'ledger.account.invalid_identifier',
  entryTooFewPostings: 'ledger.entry.too_few_postings',
  entryUnbalanced: 'ledger.entry.unbalanced',
  entryFeeIntoClientFunds: 'ledger.entry.fee_into_client_funds',
  entryClientFundsCrossSubsidy: 'ledger.entry.client_funds_cross_subsidy',
  entryCorrectionWithoutReference: 'ledger.entry.correction_without_reference',
  entrySettlementWithReference: 'ledger.entry.settlement_with_reference',
  postingNonPositiveAmount: 'ledger.posting.non_positive_amount',
  postingCustodyWithoutAttribution: 'ledger.posting.custody_without_attribution',
  postingAttributionMismatch: 'ledger.posting.attribution_mismatch',
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
