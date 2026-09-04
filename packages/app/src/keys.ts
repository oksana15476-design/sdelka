import { type IdentityDocument, identityKey } from '@sdelka/compliance';
import { type ClientKey, clientKey } from '@sdelka/ledger';

/**
 * Мост между ключом личности и ключом счёта в учёте.
 *
 * `packages/ledger/src/accounts.ts` прямо пишет: форма ключа личности
 * (`страна:тип:отпечаток`) в учёт не попадает, потому что содержит двоеточие —
 * разделитель кода счёта, — и «перевод одного в другое — забота compliance».
 * Функции перевода в `@sdelka/compliance` **нет**: `payerKeyForDomain` отдаёт
 * ключ личности как есть, и он годится только для `g_payer_matches`, где домен
 * сравнивает строки. Поэтому перевод живёт здесь, в приложении, и вынесен в
 * отчёт как шов между пакетами (см. отчёт по батчу, расхождение 1).
 *
 * Двоеточие заменяется точкой: обе части ключа личности (код страны ISO 3166-1
 * alpha-2 и тип документа из закрытого перечня) точки не содержат, поэтому
 * замена обратима и не склеивает разные ключи.
 */
export function toClientKey(document: IdentityDocument): ClientKey {
  return clientKey(identityKey(document).replaceAll(':', '.'));
}
