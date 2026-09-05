import type { GuardId, WithdrawalGuardId } from '@sdelka/domain';

/**
 * Имя guard'а домена → ключ его подписи в словаре.
 *
 * ## Зачем карта, а если ключ собирался шаблоном
 *
 * Прежде подпись собиралась прямо в разметке: `ops.guard.${guard}` для
 * произвольной строки из домена. В словарях при этом жили **четыре** ключа, а
 * в домене — двадцать три имени (`GUARD_IDS` двадцать, `WITHDRAWAL_GUARD_IDS`
 * ещё пять, два общих). Девятнадцать причин отказа печатались оператору
 * меткой вида `[ops.guard.g_funds_locked]`: строка, которую словарь не знает,
 * а сборка не ловит, потому что ключ существует только в момент отрисовки.
 *
 * Карта закрывает это типом: `Record` по объединению `GuardId |
 * WithdrawalGuardId` полон по построению, и новое имя в домене роняет
 * `tsc`, а не экран оператора.
 *
 * ## Почему у одного guard'а ключ не совпадает с именем
 *
 * У одного guard'а домена в имени стоит ролевое название стороны сделки, и
 * ключ `ops.guard.<имя>` для него невыразим: `checkDictionaries` в
 * `scripts/verify-ui.mjs` роняет прогон на любом ключе локализации, в имени
 * которого встречается ролевое название стороны или рабочего места. Запрет
 * осмысленный — роль это свойство сделки, а не раздел интерфейса
 * (`CABINETS.md` §0.4), — но имя guard'а живёт в домене и переименованию
 * отсюда не подлежит.
 *
 * Отсюда ровно одно расхождение имени и ключа, и оно названо здесь, а не
 * спрятано в шаблоне: ключ говорит словарём продукта (`paying`/`receiving`),
 * имя — словарём домена. Что расхождение одно, держит тест
 * `i18n/three-languages.test.ts`.
 */
export const GUARD_LABEL_KEY: Readonly<Record<GuardId | WithdrawalGuardId, string>> = Object.freeze({
  g_amount_sufficient: 'ops.guard.g_amount_sufficient',
  g_payer_matches: 'ops.guard.g_payer_matches',
  g_evidence_present: 'ops.guard.g_evidence_present',
  g_observation_sufficient: 'ops.guard.g_observation_sufficient',
  g_fields_match: 'ops.guard.g_fields_match',
  // Единственное расхождение имени и ключа — причина в шапке.
  g_owner_is_buyer: 'ops.guard.g_owner_is_paying_party',
  g_approvals_sufficient: 'ops.guard.g_approvals_sufficient',
  g_beneficiary_locked: 'ops.guard.g_beneficiary_locked',
  g_beneficiary_verified: 'ops.guard.g_beneficiary_verified',
  g_no_active_payout: 'ops.guard.g_no_active_payout',
  g_funds_collected: 'ops.guard.g_funds_collected',
  g_funds_locked: 'ops.guard.g_funds_locked',
  g_coverage_ok: 'ops.guard.g_coverage_ok',
  g_source_account_known: 'ops.guard.g_source_account_known',
  g_condition_agreed: 'ops.guard.g_condition_agreed',
  g_mismatch_resolved: 'ops.guard.g_mismatch_resolved',
  g_write_off_approvers_distinct: 'ops.guard.g_write_off_approvers_distinct',
  g_write_off_covers_collected: 'ops.guard.g_write_off_covers_collected',
  g_amendment_accepted_by_both: 'ops.guard.g_amendment_accepted_by_both',
  g_unfreeze_approvers_distinct: 'ops.guard.g_unfreeze_approvers_distinct',
  g_free_balance_sufficient: 'ops.guard.g_free_balance_sufficient',
  g_withdrawal_approvers_distinct: 'ops.guard.g_withdrawal_approvers_distinct',
  g_no_active_withdrawal: 'ops.guard.g_no_active_withdrawal',
});

/** Имя guard'а, которое экран умеет подписать. */
export type LabelledGuardId = keyof typeof GUARD_LABEL_KEY;
