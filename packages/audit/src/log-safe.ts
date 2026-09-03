import type { AuditRecord } from './record';

/**
 * JSON-безопасная проекция записи.
 *
 * Нужна ровно по одной причине: `JSON.stringify` бросает на `bigint`, а суммы в
 * журнале — только `bigint` (красная линия №4). Ничего не скрывает и не
 * маскирует: скрывать нечего, персональные данные в запись не попадают по
 * построению (`values.ts`). Именно поэтому проекцию можно сериализовать
 * целиком и проверять тестом на отсутствие подстрок — как в
 * `compliance/test/pii.test.ts`.
 */
export type JsonSafe =
  | string
  | number
  | boolean
  | null
  | readonly JsonSafe[]
  | { readonly [key: string]: JsonSafe };

function project(value: unknown): JsonSafe {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(project);
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonSafe> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = project(child);
    }
    return out;
  }
  return null;
}

export function logSafeRecord(record: AuditRecord): JsonSafe {
  return project(record);
}
