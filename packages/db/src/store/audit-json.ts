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
 * Кодировка переехала сюда из `test/int/support/audit-json.ts`, где стояла с
 * оговоркой «как именно приложение положит тело в `jsonb` — его решение».
 * Приложение появилось, решение принято, и место кодировки — рядом с ним:
 * вторая кодировка в тестах означала бы, что тест проверяет собственный круг, а
 * не тот, которым пользуется продукт.
 *
 * Однозначность разбора держится формой метки: `{"$bigint":"…"}` — объект **с
 * единственным** ключом. Тело записи собирают конструкторы `@sdelka/audit`, и
 * ключа `$bigint` в их полях нет; появись он, разбор вернул бы целое вместо
 * объекта — и это немедленно поймает сверка хеша при чтении, потому что хеш
 * считается по всему конверту.
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
