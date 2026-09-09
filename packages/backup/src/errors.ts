/**
 * Технические ключи снятия и восстановления копии. Не пользовательский текст:
 * формулировки для клиента живут в словарях локализации (`CLAUDE.md`, «Три
 * языка»), а это читает дежурный в три часа ночи.
 *
 * **Здесь только то, чему нет имени ни в одном пакете.** Разрыв цепочки
 * журнала, расхождение версии схемы и нарушение покрытия поднимаются **теми
 * же** ключами, что и в бою: `AuditErrorCode`, `DbErrorCode`, `InvariantCode`.
 * Второй ключ для того же нарушения означал бы, что «журнал порван» на проде и
 * «журнал порван» в восстановленной копии читаются по-разному, а это ровно тот
 * случай, когда сравнивать их придётся глазами и срочно.
 */
export const BackupErrorCode = {
  /** Строка подключения не разбирается либо не `postgresql://`. */
  urlInvalid: 'backup.url.invalid',
  /** Переменная окружения не задана. Значения по умолчанию нет (красная линия №12). */
  envMissing: 'backup.env.missing',
  /** Внешняя команда (`pg_dump`, `pg_restore`, `psql`) завершилась с ненулевым кодом. */
  commandFailed: 'backup.command.failed',
  /** Внешней команды нет в `PATH`. Отдельно от `commandFailed`: чинится иначе. */
  commandMissing: 'backup.command.missing',
  /** Файл копии, слепок или контрольная сумма не найдены рядом друг с другом. */
  setIncomplete: 'backup.set.incomplete',
  /** Слепок не разбирается либо собран другой версией формата. */
  manifestInvalid: 'backup.manifest.invalid',
  /**
   * Контрольная сумма файла копии не совпала с записанной при снятии.
   *
   * Проверяется **до** восстановления. Обрезанный на середине файл `pg_restore`
   * читает молча ровно до места обрыва и завершается успехом на том, что успел
   * прочитать: без этой проверки половина базы выглядела бы как целая база.
   */
  digestMismatch: 'backup.digest.mismatch',
  /** Цель восстановления совпала с источником. Копию восстанавливают не поверх оригинала. */
  targetIsSource: 'backup.restore.target_is_source',
  /* --- Сверка восстановленного со слепком --------------------------------- */
  /** Версия схемы восстановленной базы не та, что записана в слепке. */
  schemaVersionMismatch: 'backup.verify.schema_version_mismatch',
  /** Набор таблиц схемы разошёлся: таблица пропала при восстановлении либо появилась лишняя. */
  tableSetMismatch: 'backup.verify.table_set_mismatch',
  /** Число строк таблицы разошлось со слепком. */
  tableRowsMismatch: 'backup.verify.table_rows_mismatch',
  /** Набор цепочек журнала разошёлся: цепочка не доехала целиком. */
  chainSetMismatch: 'backup.verify.chain_set_mismatch',
  /** Голова цепочки в восстановленной базе не та, что была при снятии. */
  chainHeadMismatch: 'backup.verify.chain_head_mismatch',
  /** Число записей цепочки разошлось со слепком. */
  chainLengthMismatch: 'backup.verify.chain_length_mismatch',
  /** Покрытие клиентских средств по валюте разошлось со слепком. */
  coverageMismatch: 'backup.verify.coverage_mismatch',
  /**
   * Сумма проводок по валюте разошлась со слепком.
   *
   * Отдельно от числа строк: строк может остаться столько же, а сумма — уехать.
   * Это ловит порчу значения, а не потерю записи.
   */
  postingSumMismatch: 'backup.verify.posting_sum_mismatch',
  /**
   * Проверять было нечего: в восстановленной базе ни одной записи журнала
   * учёта и ни одной записи журнала аудита.
   *
   * Это **отказ**, а не успех. Иначе «копия прочиталась» и «копия цела»
   * сходятся в один зелёный ответ, и учение, снявшее копию не с той базы,
   * отчитается о полном успехе. Пустая база — законное состояние ровно один раз
   * в жизни продукта, и на этот случай есть явный флаг `--allow-empty`.
   */
  nothingChecked: 'backup.verify.nothing_checked',
} as const;

export type BackupErrorCode = (typeof BackupErrorCode)[keyof typeof BackupErrorCode];

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: BackupErrorCode, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}
