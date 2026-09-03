import { createHash } from 'node:crypto';
import { AuditError, AuditErrorCode } from './errors';

const HEX_64 = /^[0-9a-f]{64}$/u;

declare const sha256Brand: unique symbol;

/** Шестнадцатеричный SHA-256 в нижнем регистре, 64 знака. */
export type Sha256Hex = string & { readonly [sha256Brand]: 'sha256' };

export function sha256Hex(value: string): Sha256Hex {
  if (!HEX_64.test(value)) {
    throw new AuditError(AuditErrorCode.hashInvalid);
  }
  return value as Sha256Hex;
}

export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}

/** Начало цепочки: предыдущего хеша нет, и это выражено значением, а не `null`. */
export const ZERO_HASH: Sha256Hex = sha256Hex('0'.repeat(64));

/**
 * Доменный префикс. Входит в каждый хеш записи, поэтому хеш, посчитанный для
 * другой цели тем же алгоритмом, нельзя выдать за хеш записи журнала, и запись
 * нельзя перенести в чужую цепочку с сохранением хеша.
 */
export const HASH_DOMAIN = 'sdelka/audit/v1';

const encoder = new TextEncoder();

/** Каждая часть идёт с длиной в байтах: иначе `['ab','c']` и `['a','bc']` дают один хеш. */
function feed(hash: ReturnType<typeof createHash>, part: string): void {
  const bytes = encoder.encode(part);
  hash.update(encoder.encode(`${bytes.length}:`));
  hash.update(bytes);
}

export function digestOfParts(parts: readonly string[], domain: string = HASH_DOMAIN): Sha256Hex {
  const hash = createHash('sha256');
  feed(hash, domain);
  for (const part of parts) {
    feed(hash, part);
  }
  return hash.digest('hex') as Sha256Hex;
}

/**
 * Отпечаток сырых байтов — БЕЗ доменного префикса и без длины, намеренно.
 *
 * Этот отпечаток предъявляется третьему лицу вместе с файлом ответа источника,
 * и оно обязано суметь пересчитать его обычным `sha256sum`, не зная ничего про
 * наш формат. Внутренний хеш записи и отпечаток внешнего файла — две разные
 * вещи, и склеивать их одной функцией нельзя (`CORE.md` Ф11: разобранные поля
 * без исходника суд не убедит).
 */
export function digestOfBytes(bytes: Uint8Array): Sha256Hex {
  return createHash('sha256').update(bytes).digest('hex') as Sha256Hex;
}
