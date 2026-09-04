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
  // Запись расчёта оставляет платформе больше, чем позволяет потолок удержания
  // (`fee-ceiling.ts`, эпик E16). Удержание считается вычитанием — брутто с
  // запертой части минус то, что дошло до получателя, — поэтому под правило
  // попадает любое удержание, а не только то, что названо комиссией.
  entryFeeExceedsCeiling: 'ledger.entry.fee_exceeds_ceiling',
  // Сам потолок задан величиной, которой не существует: отрицательной, больше
  // единицы либо применённой к отрицательной сумме.
  feeCeilingInvalid: 'ledger.fee_ceiling.invalid',
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
  // Отмотать назад просят не расчёт: запись другого вида либо без объявления
  // расчёта. Реверс строится зеркалом самой записи, и зеркалить нечего.
  entryReversalTargetNotSettlement: 'ledger.entry.reversal_target_not_settlement',
  entryCorrectionWithoutReference: 'ledger.entry.correction_without_reference',
  entrySettlementWithReference: 'ledger.entry.settlement_with_reference',
  postingNonPositiveAmount: 'ledger.posting.non_positive_amount',
  // Требование по комиссии живёт без отнесения к траншу либо отнесено к файлу
  // клиента. Комиссия связывается со сделкой **только** отнесением: в коде
  // счёта `fee:receivable` файла нет и быть не может. Без отнесения начисление
  // не видит ни `openFeeReceivables`, ни идемпотентность `journalFeeAccruedTwice`.
  postingFeeWithoutTrancheAttribution: 'ledger.posting.fee_without_tranche_attribution',
  postingCustodyWithoutAttribution: 'ledger.posting.custody_without_attribution',
  postingAttributionMismatch: 'ledger.posting.attribution_mismatch',
  postingClientAttributionMismatch: 'ledger.posting.client_attribution_mismatch',
  // Запись пришла в журнал без обязательного поля: не `JournalEntry`, а объект,
  // похожий на него. Журнал приходит из базы и из сериализации, поэтому такое
  // значение обязано отвергаться названной ошибкой, а не падать `TypeError` на
  // первом же обращении к отсутствующему полю.
  journalEntryMalformed: 'ledger.journal.entry_malformed',
  journalDuplicateEntryId: 'ledger.journal.duplicate_entry_id',
  journalCorrectionTargetMissing: 'ledger.journal.correction_target_missing',
  // Второе начисление комиссии по тому же траншу. Идемпотентность начисления
  // (§4.6, Ф16): «начислено» — величина транша, а не счётчик вызовов.
  journalFeeAccruedTwice: 'ledger.journal.fee_accrued_twice',
  // Один и тот же расчёт отматывается назад второй раз. Первый реверс вернул
  // деньги плательщику целиком; второй увёл бы файл получателя в минус и
  // открыл требование по комиссии, которого никто не начислял.
  journalSettlementReversedTwice: 'ledger.journal.settlement_reversed_twice',
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
