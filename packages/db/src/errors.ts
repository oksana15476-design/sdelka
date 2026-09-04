/**
 * Технические ключи ошибок базы. Не пользовательский текст: формулировки для
 * клиента живут в словарях локализации (CLAUDE.md, «Три языка»).
 *
 * **Здесь только те ключи, которых нет ни в одном пакете.** Всё, чему в коде уже
 * есть имя, база поднимает **тем же именем**, буква в букву: `LedgerErrorCode`,
 * `InvariantCode` (`packages/ledger`), `AuditErrorCode` (`packages/audit`).
 * Второй ключ для того же нарушения означал бы, что дежурный читает два разных
 * сообщения об одном и том же в зависимости от того, кто поймал — код или база.
 *
 * Префикс `db.` у здешних ключей честный: это правила, которых в коде нет вовсе,
 * потому что их некому было проверять. Журнал учёта и журнал аудита не
 * редактируются (красная линия №11) — в TS это выражено отсутствием изменяющих
 * функций, то есть **ключа ошибки там и не могло быть**: нарушение невыразимо. В
 * базе оно выразимо всегда, поэтому у запрета появляется имя.
 */
export const DbErrorCode = {
  /** Журнал учёта только дополняется: `UPDATE`/`DELETE` по записи или проводке. */
  ledgerAppendOnly: 'db.ledger.append_only',
  /** Журнал аудита только дополняется — красная линия №11, CORE.md Ф11. */
  auditAppendOnly: 'db.audit.append_only',
  /** Разрыв нумерации в цепочке: `seq` не равен предыдущему плюс один. */
  auditChainGap: 'db.audit.chain_gap',
  /** Предыдущий хеш не равен хешу предыдущей записи цепочки. */
  auditPrevHashMismatch: 'db.audit.prev_hash_mismatch',
  /**
   * Цепочка открывается записью `chain_opened` с `seq = 0` и нулевым предыдущим
   * хешом. Без явного генезиса «пустая цепочка» и «цепочка с отрезанным
   * началом» неразличимы (`packages/audit/src/chain.ts`, `genesisChain`).
   */
  auditGenesisRequired: 'db.audit.genesis_required',
  /** Роль приложения не владеет объектами схемы и не является суперпользователем. */
  roleNotSeparated: 'db.role.not_separated',
  /** Роли схемы не заведены: см. `scripts/dev-db.sh`. */
  roleMissing: 'db.role.missing',
  /** Форма счёта не соответствует его виду: нет валюты, владельца или транша. */
  postingAccountShape: 'db.posting.account_shape',
  /** Контрольная сумма уже применённой миграции не совпала с файлом. */
  migrationChecksumMismatch: 'db.migration.checksum_mismatch',
  /** Файл миграции пропал, а запись о его применении осталась. */
  migrationMissing: 'db.migration.missing',
  /** `SDELKA_DATABASE_URL` не задан: строка подключения только из окружения. */
  databaseUrlMissing: 'db.env.database_url_missing',
  /**
   * База не ответила за отведённый срок (`PROBE_TIMEOUT_MS`). Отдельный ключ, а
   * не текст драйвера: по нему `isDatabaseUnreachable` отличает «до базы не
   * добрались» (законный пропуск набора) от «сервер ответил отказом» (дефект
   * настройки, обязан ронять прогон).
   */
  connectTimeout: 'db.connect.timeout',
} as const;

export type DbErrorCode = (typeof DbErrorCode)[keyof typeof DbErrorCode];

export class DbError extends Error {
  readonly code: DbErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: DbErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'DbError';
    this.code = code;
    this.details = details;
  }
}
