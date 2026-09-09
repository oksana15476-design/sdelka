import { BackupError } from '../errors.ts';
import type { Finding } from '../verify.ts';

/**
 * Вывод команд в терминал. Правила те же, что у `packages/db/src/cli/report.ts`,
 * и повторены здесь не по невнимательности: у `db` это внутренний модуль
 * команды, а не экспорт пакета, и тащить его наружу значило бы объявить
 * контрактом то, что им не объявлено.
 *
 * 1. **Ни одного значения окружения.** Строка подключения не печатается ни при
 *    каком исходе (красная линия №12): у `pg` в свойствах ошибки лежит и хост,
 *    и пользователь, поэтому вывод собирается вручную, а не `console.error`.
 * 2. **Технический ключ, а не фраза.** `backup.verify.chain_head_mismatch`
 *    ищется грепом; «голова цепочки не сошлась» не ищется.
 */
export function detailsLine(details: Readonly<Record<string, string>>): string {
  return Object.entries(details)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => ` ${key}=${value}`)
    .join('');
}

export function failureLine(error: unknown): string {
  if (error instanceof BackupError) return `${error.code}${detailsLine(error.details)}`;
  if (typeof error === 'object' && error !== null && 'code' in error && 'details' in error) {
    // `DbError`, `AuditError`: та же форма, тот же вывод. Проверка по форме, а
    // не по классу, — пакет не обязан зависеть от каждого, кто умеет бросать.
    const shaped = error as { code: unknown; details: unknown };
    if (typeof shaped.code === 'string' && typeof shaped.details === 'object') {
      return `${shaped.code}${detailsLine(shaped.details as Record<string, string>)}`;
    }
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function findingLine(item: Finding): string {
  return `${item.code}${detailsLine(item.details)}`;
}

/** Печатает отказ и возвращает код выхода. Возврат, а не `process.exit`: тестируемо. */
export function reportFailure(error: unknown, write: (line: string) => void): number {
  write(`${failureLine(error)}\n`);
  return 1;
}
