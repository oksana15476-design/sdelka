import type { DocumentNumberMatch, NameObservation, SanctionsProviderResponse, SanctionsScreeningPort, SanctionsScreeningRequest } from '@sdelka/compliance';
import type { Instant, PayoutOutcome, ReconciliationOutcome, StatementFields } from '@sdelka/domain';
import type { CapturedRawSource, RawSourceRef } from '@sdelka/audit';

/**
 * Порты внешних источников — **единственное**, что подставляется фикстурами.
 *
 * Ни один из них не является моком платёжного провайдера в смысле `CLAUDE.md`:
 * у них нет ожиданий, нет проверки вызовов и нет поведения. Это источники
 * фактов и событий. Автомат работает на событиях: банк не «вызывается» из
 * редьюсера — приложение берёт у порта исход и подаёт его событием
 * `payout_result`, как это и описано в `STATE-MACHINES.md` §7.
 *
 * Сети здесь нет ни в одном виде: реализации в `packages/e2e/test/support` —
 * константы.
 */

/**
 * Ответ реестра — **три различимых исхода, а не значение и `null`**.
 *
 * Прежний `paidExtract(): RegistryExtract | null` склеивал два совершенно
 * разных факта в одно значение: «реестр ответил, перехода права нет» и
 * «реестр не ответил». Первое — основание отказать в выплате; второе —
 * технический инцидент, при котором часы сделки приостанавливаются, а не
 * запускается возврат (`ORACLE.md` §10, `FUNCTIONAL.md` §3.6). Комментарий в
 * прежней редакции честно признавал, что второго исхода «здесь нет намеренно», —
 * но именно этот исход и есть тот, ради которого у машины наблюдения
 * существует нетерминальное состояние `unavailable`.
 *
 * `unavailable` несёт ключ причины, а не текст: три языка (`CLAUDE.md`).
 */
export type RegistryAnswer<T> =
  | { readonly kind: 'found'; readonly value: T }
  /** Реестр ответил, и в ответе нужного факта нет. Это ответ, а не молчание. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reasonKey: string };

/**
 * Платная выписка реестра — источник факта `registration_transfer`
 * (`STATE-MACHINES.md` §8, уровень доверия L3).
 *
 * **Здесь нет ни одного готового вердикта.** Прежняя редакция несла поле
 * `ownerIsBuyer: boolean`, и порт таким образом сам отвечал на вопрос, ради
 * которого существует `reconcileOwner` в `@sdelka/compliance`: адаптер реестра
 * решал, установлен ли собственник. Теперь порт отдаёт **наблюдения**
 * (совпадение по номеру документа и имена собственника из выписки), а вердикт
 * считает приложение настоящей функцией комплаенса — и «выписка не отдала
 * номер документа» превращается в `insufficient`, а не в `false`, которое
 * неотличимо от «собственник другой» (`CORE.md` Ф7, `ORACLE.md` §5.3).
 */
export interface RegistryExtract {
  /** Пять полей §3.5, сверенные адаптером с данными сделки. */
  readonly fields: StatementFields;
  /** Сверка собственника ведётся по номеру документа, не по имени (`CORE.md` Ф7). */
  readonly ownerDocumentNumber: DocumentNumberMatch;
  /** Имена собственника из выписки: вторичный сигнал, сам по себе ничего не решает. */
  readonly ownerNames: readonly NameObservation[];
  /** Кадастровый код объекта, о котором выписка. Сверяется с объектом сделки. */
  readonly cadastralCode: string;
  /**
   * **Подтверждённый** сырой ответ источника, а не ссылка на него.
   *
   * Ссылки было мало: отпечаток проверялся на форму, и наблюдение с
   * отпечатком, за которым не стоит ни одного записанного ответа, доходило до
   * выплаты. Байты есть у адаптера в момент разбора — значит подтверждение
   * строится там, где оно возможно, а не откладывается на потребителя, у
   * которого байтов уже нет (`CORE.md` Ф11, красная линия №5).
   */
  readonly rawSource: CapturedRawSource;
  readonly observedAt: Instant;
}

/**
 * Карточка заявления — **бесплатный** сигнал уровня L1 (`ORACLE.md` §2).
 *
 * Дешёвый сигнал управляет таймингом, дорогой — деньгами: карточка запускает
 * отсчёт регламентного срока и запрещает автооткат, но выплату не открывает
 * никогда.
 *
 * ⚠ **Сырого ответа здесь нет, и это названное расхождение, а не упущение.**
 * `RAW_SOURCE_KINDS` в `@sdelka/audit` вида `application_card` не содержит, а
 * переиспользовать `registry_extract` нельзя: восстановление истории через год
 * показало бы карточку платной выпиской, то есть соврало бы об уровне доверия.
 * Поэтому карточка несёт только отпечаток ответа (SHA-256, 64 hex) — его
 * достаточно для `ReleaseObservation.rawSourceDigest`, — и в пакет
 * доказательств выплаты не попадает вовсе. Чинится одной строкой в
 * `packages/audit/src/raw-source.ts` (чужой пакет, см. отчёт E3).
 */
export interface RegistryApplicationCard {
  readonly applicationId: string;
  readonly cadastralCode: string;
  /**
   * Статус карточки — непрозрачная строка. `CORE.md` Ф7: «статус „завершено“
   * не значит ничего — заявление может быть закрыто отказом». Ни одно решение
   * его не читает, значение едет в состояние ради восстановления истории.
   */
  readonly applicationStatus: string;
  /** Отпечаток сырого ответа: SHA-256, 64 hex. */
  readonly digest: string;
  readonly observedAt: Instant;
}

export interface RegistryPort {
  /** Платная выписка по объекту. Уровень L3, единственное основание для денег. */
  paidExtract(cadastralRef: string): RegistryAnswer<RegistryExtract>;
  /** Карточка заявления по номеру, названному стороной. Уровень L1. */
  applicationCard(applicationId: string): RegistryAnswer<RegistryApplicationCard>;
  /** Открытое заявление по объекту: то же, но искомое нами, а не названное стороной. */
  openApplication(cadastralRef: string): RegistryAnswer<RegistryApplicationCard>;
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
