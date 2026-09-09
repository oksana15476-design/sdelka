import { DbError } from '../errors.ts';

/**
 * Отчёт команд базы в терминал.
 *
 * Два правила, и оба про то, что читает дежурный.
 *
 * 1. **Ни одного значения окружения.** Строка подключения не печатается ни в
 *    успехе, ни в отказе, ни в стеке (красная линия №12). Отсюда и вывод
 *    собирается вручную, а не `console.error(error)`: у `pg` в свойствах
 *    ошибки лежит и хост, и пользователь.
 * 2. **Технический ключ, а не фраза.** `db.schema.behind` ищется грепом и
 *    переводится словарём; «схема отстаёт» не ищется и не переводится
 *    (`CLAUDE.md`, «Три языка»: пользовательский текст живёт в локализации, а
 *    вывод команды — не пользовательский текст, но и выдумывать ему фразы
 *    незачем).
 */
export function failureLine(error: unknown): string {
  if (error instanceof DbError) {
    const details = Object.entries(error.details)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => ` ${key}=${value}`)
      .join('');
    return `${error.code}${details}`;
  }
  // Чужая ошибка (драйвер, файловая система): сообщение как есть, без стека и
  // без свойств — в свойствах `pg` лежит адрес базы.
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Печатает отказ и возвращает код выхода. Возврат, а не `process.exit`: тестируемо. */
export function reportFailure(error: unknown, write: (line: string) => void): number {
  write(`${failureLine(error)}\n`);
  return 1;
}
