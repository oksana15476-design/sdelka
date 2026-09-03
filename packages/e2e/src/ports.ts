import type { DocumentNumberMatch, SanctionsProviderResponse, SanctionsScreeningPort, SanctionsScreeningRequest } from '@sdelka/compliance';
import type { Instant, PayoutOutcome, ReconciliationOutcome, StatementFields } from '@sdelka/domain';
import type { RawSourceRef } from '@sdelka/audit';

/**
 * Порты внешних источников — **единственное**, что подставляется фикстурами.
 *
 * Ни один из них не является моком платёжного провайдера в смысле `CLAUDE.md`:
 * у них нет ожиданий, нет проверки вызовов и нет поведения. Это источники
 * фактов и событий. Автомат работает на событиях: банк не «вызывается» из
 * редьюсера — приложение берёт у порта исход и подаёт его событием
 * `payout_result`, как это и описано в `STATE-MACHINES.md` §7.
 *
 * Сети здесь нет ни в одном виде: реализации в `test/support` — константы.
 */

/**
 * Платная выписка реестра — источник факта `registration_transfer`
 * (`STATE-MACHINES.md` §8). `null` означает «перехода права в реестре нет»,
 * а не «не смогли посмотреть»: второе — отдельный исход, и до появления
 * реального адаптера его здесь нет намеренно.
 */
export interface RegistryExtract {
  readonly statementFields: StatementFields;
  /** Новый собственник — покупатель. На этом стоит `g_owner_is_buyer`. */
  readonly ownerIsBuyer: boolean;
  /** Сверка собственника ведётся по номеру документа, не по имени (`CORE.md` Ф7). */
  readonly ownerDocumentNumber: DocumentNumberMatch;
  /** Ссылка на сырой ответ источника: разобранные поля суд не убедят (Ф11). */
  readonly rawSource: RawSourceRef;
  readonly observedAt: Instant;
}

export interface RegistryPort {
  paidExtract(cadastralRef: string): RegistryExtract | null;
}

/**
 * Исход поручения. `unknown` обязателен как отдельное значение: ни один адаптер
 * не возвращает `rejected` при сетевой ошибке (`STATE-MACHINES.md` §2.2).
 * У `settled` и `rejected` сырой ответ обязателен, у `unknown` его может не
 * быть, но обязателен ключ причины — форма повторяет `PayoutResultBody`.
 */
export type BankOutcome =
  | { readonly outcome: Exclude<PayoutOutcome, 'unknown'>; readonly response: RawSourceRef; readonly reasonKey: string | null }
  | { readonly outcome: 'unknown'; readonly response: RawSourceRef | null; readonly reasonKey: string };

export interface BankPort {
  /** Исход по ключу идемпотентности. Повторный вызов с тем же ключом отдаёт то же. */
  outcomeFor(idempotencyKey: string): BankOutcome;
  /**
   * Ежедневная сверка с выпиской — единственный выход из `unknown`
   * (`STATE-MACHINES.md` §2.2). `null` — сверка ещё не дала ответа.
   */
  reconcile(idempotencyKey: string): ReconciliationOutcome | null;
}

export type { SanctionsProviderResponse, SanctionsScreeningPort, SanctionsScreeningRequest };

export interface Ports {
  readonly registry: RegistryPort;
  readonly bank: BankPort;
  readonly screening: SanctionsScreeningPort;
}
