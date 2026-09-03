import { AuditError, AuditErrorCode } from './errors';
import { type Sha256Hex, digestOfBytes, sha256Hex } from './hash';
import type { AuditInstant } from './instant';
import { auditToken } from './values';

/**
 * Ссылка на сырой ответ источника.
 *
 * `CORE.md` Ф11: «отсутствие сырого ответа источника — разобранные поля без
 * исходника суд не убедит». И одновременно — в журнал не должны попадать
 * номера документов и реквизиты в открытом виде. Выписка из реестра содержит
 * и то и другое, так что требования сталкиваются лоб в лоб.
 *
 * **Решение:** в неизменяемую цепочку идёт не ответ, а его отпечаток. Сами
 * байты живут в модуле «Документы» (шифрование, журнал доступа —
 * `FUNCTIONAL.md` §1), откуда их можно выдать суду и, при законном требовании,
 * удалить. Связь «эта запись — про эти байты» держится криптографией:
 * `verifyRawSource` пересчитывает отпечаток, и изменение хотя бы одного байта
 * рвёт связь. Байты внутри вечного журнала дали бы обратное: удалить нельзя,
 * а доказательная сила та же самая.
 */
export const RAW_SOURCE_KINDS = [
  'identity_document',
  'kinship_document',
  'ownership_document',
  'contract',
  'registry_extract',
  'bank_statement',
  'screening_response',
  'test_transfer',
  'operator_note',
  'condition_act',
  'payment_provider_response',
  'timestamp_response',
] as const;
export type RawSourceKind = (typeof RAW_SOURCE_KINDS)[number];

export interface RawSourceRef {
  readonly kind: 'raw_source';
  readonly sourceKind: RawSourceKind;
  /** Адрес в хранилище документов. Не сам ответ. */
  readonly storageRef: string;
  readonly mediaType: string;
  readonly byteLength: number;
  /** Обычный SHA-256 по байтам: третья сторона пересчитывает его `sha256sum`. */
  readonly digest: Sha256Hex;
  readonly receivedAt: AuditInstant;
  /** Кто ответил: реестр, банк, провайдер выплат. Технический ключ, не название. */
  readonly provider: string;
}

export interface RawSourceInput {
  readonly sourceKind: RawSourceKind;
  readonly storageRef: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly receivedAt: AuditInstant;
  readonly provider: string;
}

export function rawSourceRef(input: RawSourceInput): RawSourceRef {
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0) {
    throw new AuditError(AuditErrorCode.rawSourceByteLengthInvalid);
  }
  return Object.freeze({
    kind: 'raw_source' as const,
    sourceKind: input.sourceKind,
    storageRef: auditToken(input.storageRef),
    mediaType: auditToken(input.mediaType),
    byteLength: input.byteLength,
    digest: sha256Hex(input.digest),
    receivedAt: input.receivedAt,
    provider: auditToken(input.provider),
  });
}

/** Отпечаток байтов для построения ссылки. Отдельно, чтобы не тянуть байты в тип. */
export function rawSourceDigest(bytes: Uint8Array): Sha256Hex {
  return digestOfBytes(bytes);
}

/**
 * Сходятся ли предъявленные байты с записью. Длина проверяется до отпечатка не
 * ради скорости: расхождение длины при совпавшем отпечатке означало бы
 * подобранную коллизию, и такой случай обязан быть отличим в отчёте.
 */
export function verifyRawSource(bytes: Uint8Array, ref: RawSourceRef): boolean {
  return bytes.length === ref.byteLength && digestOfBytes(bytes) === ref.digest;
}
