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
  entryObligationIntoIntakePool: 'ledger.entry.obligation_into_intake_pool',
  entryTerminalPoolPayout: 'ledger.entry.terminal_pool_payout',
  entryClientFileGainUnfunded: 'ledger.entry.client_file_gain_unfunded',
  settlementSelfDealing: 'ledger.settlement.self_dealing',
  settlementAttestationMismatch: 'ledger.settlement.attestation_mismatch',
  entryNonPositiveExcess: 'ledger.entry.non_positive_excess',
  entryNonPositiveShortfall: 'ledger.entry.non_positive_shortfall',
  entryNonPositiveFee: 'ledger.entry.non_positive_fee',
  // Клиентский курс лучше эталонного: на конвертации не доход, а убыток, и
  // проводка у него другая. Молча вывернуть направление значило бы признать
  // убыток доходом (см. `receiveConversion`).
  entryNegativeSpread: 'ledger.entry.negative_spread',
  // Объявление обмена не сходится с собственным содержимым: целевая сумма не
  // равна исходной по клиентскому курсу. Курс с недавних пор несёт свою пару
  // валют (`money/fx.ts`), но сумма до сих пор приезжала аргументом.
  entryConversionDeclarationMismatch: 'ledger.entry.conversion_declaration_mismatch',
  // Проводка по счёту расчётов с валютным контрагентом в записи, которая обмен
  // не объявляет, объявляет чужой обмен или двигает не ту сумму.
  entryConversionUndeclared: 'ledger.entry.conversion_undeclared',
  // Комиссия удерживается из платежа, не будучи начисленной, либо начисление
  // относится к другому траншу или другой сумме.
  entryFeeAccrualMismatch: 'ledger.entry.fee_accrual_mismatch',
  // Довнесение недостачи не совпадает с собственным объявлением: прирост в
  // чужом файле, в чужой валюте, не на объявленную сумму или не из денег
  // платформы.
  entryShortfallFundingMismatch: 'ledger.entry.shortfall_funding_mismatch',
  entryCorrectionWithoutReference: 'ledger.entry.correction_without_reference',
  entrySettlementWithReference: 'ledger.entry.settlement_with_reference',
  postingNonPositiveAmount: 'ledger.posting.non_positive_amount',
  postingCustodyWithoutAttribution: 'ledger.posting.custody_without_attribution',
  postingAttributionMismatch: 'ledger.posting.attribution_mismatch',
  postingClientAttributionMismatch: 'ledger.posting.client_attribution_mismatch',
  journalDuplicateEntryId: 'ledger.journal.duplicate_entry_id',
  journalCorrectionTargetMissing: 'ledger.journal.correction_target_missing',
  // Второе начисление комиссии по тому же траншу. Идемпотентность начисления
  // (§4.6, Ф16): «начислено» — величина транша, а не счётчик вызовов.
  journalFeeAccruedTwice: 'ledger.journal.fee_accrued_twice',
  // Ключ конверсии переиспользован под другой обмен: тот же счёт расчётов, но
  // другие объявленные ноги. Позиции двух обменов сложились бы в одну.
  journalConversionKeyReused: 'ledger.journal.conversion_key_reused',
  // Довнесение ссылается на признание, которого в журнале нет или которое
  // признало не то (другой клиент, другая валюта, другая сумма).
  journalShortfallRecognitionMissing: 'ledger.journal.shortfall_recognition_missing',
  // Одно признание недостачи довносится второй раз.
  journalShortfallFundedTwice: 'ledger.journal.shortfall_funded_twice',
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
