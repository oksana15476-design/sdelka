import type { Sha256Hex } from './hash';
import type { AuditInstant } from './instant';

/**
 * Порты, и только порты. Ни одной реализации, ни одного сетевого вызова, ни
 * одного обращения к окружению: `CLAUDE.md` — денежный домен тестируется без
 * сети, а секреты живут в окружении интеграции, не здесь. Реализации (TSA
 * независимого поставщика, публикация якоря) — карточки E7-5 и E7-6,
 * интеграция И8, каждая со своим дизайн-доком до кода.
 */

/**
 * Метка времени независимого поставщика. `CORE.md` Ф11: собственное время
 * оспоримо. Поставщик подписывает **отпечаток**, а не содержимое, поэтому
 * ничего из записи наружу не уходит.
 */
export interface TimestampToken {
  readonly provider: string;
  readonly issuedAt: AuditInstant;
  readonly digest: Sha256Hex;
  /** Непрозрачное доказательство поставщика (обычно DER/base64). */
  readonly token: string;
}

export interface TimestampPort {
  stamp(digest: Sha256Hex): Promise<TimestampToken>;
}

export interface TimestampVerifier {
  verify(token: TimestampToken): Promise<boolean>;
}

/**
 * Внешний якорь: головной хеш цепочки, опубликованный там, где мы не можем его
 * переписать. `BACKLOG.md` E7-5: записи, созданные до появления якоря, останутся
 * без него навсегда — поэтому непокрытый хвост возвращается как факт, а не
 * замалчивается (см. `anchor.ts`).
 */
export interface Anchor {
  readonly chainId: string;
  readonly seq: number;
  readonly headHash: Sha256Hex;
  readonly anchoredAt: AuditInstant;
  readonly provider: string;
  /** Непрозрачное доказательство публикации: идентификатор транзакции, квитанция. */
  readonly proof: string;
}

export interface AnchorPort {
  publish(chainId: string, seq: number, headHash: Sha256Hex): Promise<Anchor>;
}
