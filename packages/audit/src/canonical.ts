import { AuditError, AuditErrorCode } from './errors';

/**
 * Каноническая кодировка значения в строку — единственный вход в хеш.
 *
 * Два требования, из которых всё остальное следует:
 *
 * 1. **Детерминированность.** Порядок ключей в объекте не влияет на результат,
 *    иначе одна и та же запись, поднятая из базы другим драйвером, получит
 *    другой хеш и целая цепочка объявит себя сломанной.
 * 2. **Различимость типов.** `1n`, `1` и `"1"` обязаны давать разные хеши.
 *    Без типовых тегов подмена суммы `1000n` на строку `"1000"` не меняет хеш,
 *    и правка записи проходит незамеченной.
 *
 * Числа с плавающей точкой отвергаются. Нецелое число в журнале — это либо
 * сумма (запрещено красной линией №4: только целые минорные единицы), либо
 * величина без однозначной текстовой формы, а значит без однозначного хеша.
 */
const MAX_DEPTH = 32;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function encode(value: unknown, depth: number, seen: Set<object>, path: string): string {
  if (depth > MAX_DEPTH) {
    throw new AuditError(AuditErrorCode.canonicalTooDeep, { path });
  }
  if (value === null) {
    return 'n:';
  }
  switch (typeof value) {
    case 'string':
      // Длина в байтах перед значением: без неё `{a:'1',b:''}` и `{a:'1'} `
      // при склейке дают одинаковый поток символов.
      return `s:${byteLength(value)}:${value}`;
    case 'bigint':
      return `g:${value.toString()}`;
    case 'boolean':
      return value ? 'b:1' : 'b:0';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new AuditError(AuditErrorCode.canonicalNonIntegerNumber, { path });
      }
      return `i:${value.toString()}`;
    case 'object':
      break;
    default:
      throw new AuditError(AuditErrorCode.canonicalUnsupportedValue, { path, type: typeof value });
  }

  const asObject = value as object;
  if (seen.has(asObject)) {
    throw new AuditError(AuditErrorCode.canonicalCycle, { path });
  }
  seen.add(asObject);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item, index) =>
        encode(item, depth + 1, seen, `${path}[${index}]`),
      );
      return `a:${parts.length}:${parts.join('')}`;
    }
    const prototype = Object.getPrototypeOf(asObject) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      // Date, Map, Set, экземпляры классов: у них нет однозначного разбора в
      // поля, и хеш от них зависел бы от реализации рантайма.
      throw new AuditError(AuditErrorCode.canonicalUnsupportedValue, { path, type: 'instance' });
    }
    const source = asObject as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const child = source[key];
      if (child === undefined) {
        // `undefined` не отличим от отсутствия поля, и после сериализации в
        // базу и обратно запись поменяет хеш. Отсутствующее значение в журнале
        // выражается `null` — так же, как в `ledger/src/entry.ts`.
        throw new AuditError(AuditErrorCode.canonicalUnsupportedValue, {
          path: `${path}.${key}`,
          type: 'undefined',
        });
      }
      parts.push(`s:${byteLength(key)}:${key}`);
      parts.push(encode(child, depth + 1, seen, `${path}.${key}`));
    }
    return `o:${keys.length}:${parts.join('')}`;
  } finally {
    seen.delete(asObject);
  }
}

export function canonical(value: unknown): string {
  return encode(value, 0, new Set<object>(), '$');
}
