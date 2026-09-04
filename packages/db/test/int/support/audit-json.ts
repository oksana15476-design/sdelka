/**
 * Тело записи аудита в `jsonb` и обратно.
 *
 * **Зачем отдельная кодировка.** `JSON.stringify` на `bigint` бросает, а
 * привести сумму к `number` нельзя ни при каких обстоятельствах (красная линия
 * №4): выше 2^53 это молчаливая порча, и `canonical.ts` прямо предупреждает,
 * что запись, поднятая из базы другим драйвером, обязана давать тот же хеш.
 * Поэтому целое кодируется помеченным объектом, а не числом, и разбирается
 * обратно в `bigint`.
 *
 * Кодировка живёт в тестах, а не в `src`: как именно приложение положит тело в
 * `jsonb` — его решение, а здесь проверяется одно свойство, ради которого этот
 * файл и написан: **round-trip через базу не меняет хеш записи**.
 */
const BIGINT_TAG = '$bigint';

export function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return { [BIGINT_TAG]: value.toString() };
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = toJson(item);
    }
    return result;
  }
  return value;
}

export function fromJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fromJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const tagged = record[BIGINT_TAG];
    if (typeof tagged === 'string' && Object.keys(record).length === 1) {
      return BigInt(tagged);
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      result[key] = fromJson(item);
    }
    return result;
  }
  return value;
}
