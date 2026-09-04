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
  /**
   * Карточка заявления реестра — бесплатный сигнал уровня L1 (`ORACLE.md` §2).
   *
   * Своим видом, а не `registry_extract`: восстановление истории через год
   * показало бы карточку платной выпиской, то есть соврало бы об уровне
   * доверия, на котором двигались деньги. Значение добавлено **в конец**:
   * порядок меток перечня зеркалится в `sdelka.raw_source_kind`, а
   * `ALTER TYPE ... ADD VALUE` умеет только дописывать в конец.
   */
  'application_card',
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

/* ------------------------------------------------------------------------- */
/* Засвидетельствованный отпечаток                                           */
/* ------------------------------------------------------------------------- */

declare const attestedBrand: unique symbol;

/**
 * Отпечаток, за которым **предъявлены байты**.
 *
 * Красная линия №5 держалась на непустой строке: `rawSourceRef` принимал
 * `digest` на слово, форму проверял `sha256Hex` (64 hex) — и наблюдение с
 * отпечатком, которому не соответствует ни один полученный ответ, проходило
 * все guard'ы. Проверка формы отвечает на вопрос «похоже ли это на отпечаток»,
 * а вопрос стоит другой: «есть ли за ним ответ источника» (`CORE.md` Ф11:
 * разобранные поля без исходника суд не убедит).
 *
 * Значение этого типа получить иначе, чем предъявив байты
 * (`captureRawSource`/`attestRawSource`), нельзя: метка приватная, и подделать
 * её можно только приведением типа, которое видно в ревью. Требование,
 * выраженное типом, невозможно забыть; требование, выраженное вызовом
 * `verifyRawSource` у вызывающего, забывается — и было забыто везде, кроме
 * собственного unit-теста.
 */
export type AttestedDigest = Sha256Hex & { readonly [attestedBrand]: 'attested' };

/**
 * Ссылка, за которой стоят предъявленные байты.
 *
 * Подтип `RawSourceRef`: всё, что читает ссылку, читает и эту (запись журнала,
 * пакет доказательств, восстановление истории). Разница только в том, что
 * **построить** её без байтов нечем.
 */
export interface CapturedRawSource extends RawSourceRef {
  readonly digest: AttestedDigest;
}

export interface RawSourceCapture {
  readonly sourceKind: RawSourceKind;
  readonly storageRef: string;
  readonly mediaType: string;
  readonly receivedAt: AuditInstant;
  readonly provider: string;
  /**
   * Сами байты ответа. В значение они не попадают — из них выводятся длина и
   * отпечаток, и потому ни то, ни другое нельзя объявить мимо ответа.
   */
  readonly bytes: Uint8Array;
}

/**
 * Ответ источника получен: длина и отпечаток **выводятся из байтов**, а не
 * принимаются полями. Это и есть точка, в которой «сырой ответ записан»
 * перестаёт быть утверждением вызывающего.
 *
 * Байты после этого живут в модуле «Документы» по адресу `storageRef`
 * (шифрование, журнал доступа — `FUNCTIONAL.md` §1); в цепочку идёт ссылка.
 */
export function captureRawSource(input: RawSourceCapture): CapturedRawSource {
  const ref = rawSourceRef({
    sourceKind: input.sourceKind,
    storageRef: input.storageRef,
    mediaType: input.mediaType,
    byteLength: input.bytes.length,
    digest: digestOfBytes(input.bytes),
    receivedAt: input.receivedAt,
    provider: input.provider,
  });
  return ref as CapturedRawSource;
}

/**
 * Сведение уже записанной ссылки с предъявленными байтами.
 *
 * Нужно там, где ссылка пришла из базы (типы границу процесса не переживают),
 * а байты — из хранилища документов: суду предъявляется файл, и связь «эта
 * запись — про эти байты» обязана быть пересчитана, а не принята на веру.
 * Отказ здесь — исключение, а не `false`: продолжать с ответом, который не
 * сходится с записью, нельзя ни в одном сценарии.
 */
export function attestRawSource(bytes: Uint8Array, ref: RawSourceRef): CapturedRawSource {
  if (bytes.length !== ref.byteLength) {
    // Длина отдельной причиной: расхождение длины при совпавшем отпечатке —
    // это подобранная коллизия, и в отчёте она обязана быть отличима от
    // обычной подмены файла.
    throw new AuditError(AuditErrorCode.rawSourceNotAttested, { reason: 'byte_length' });
  }
  if (!verifyRawSource(bytes, ref)) {
    throw new AuditError(AuditErrorCode.rawSourceNotAttested, { reason: 'digest' });
  }
  return ref as CapturedRawSource;
}
