import { ComplianceError, ComplianceErrorCode } from './errors';

/**
 * Персональные данные внутри пакета.
 *
 * Номер документа и личный номер — специальные категории по нашей юрисдикции,
 * и внутрь решений комплаенса они не попадают вовсе: пакет оперирует
 * **отпечатками** — результатом ключевого хеширования, выполненного снаружи с
 * «перцем» из окружения (красная линия №12: секреты только из окружения, и
 * потому вычисление отпечатка не может жить в чистом пакете).
 *
 * Что это даёт: сравнение «тот же документ / тот же счёт» остаётся возможным,
 * а сам номер физически недоступен ни решению, ни журналу, ни тесту.
 *
 * Имя — исключение по необходимости: сопоставление имён требует самих строк.
 * Поэтому имена живут только в наблюдениях и **никогда не попадают в журнальную
 * проекцию решения** — см. `logSafe*` ниже и тест `pii.test.ts`.
 */
const HEX_64 = /^[0-9a-f]{64}$/u;

declare const fingerprintBrand: unique symbol;

type Branded<K extends string> = string & { readonly [fingerprintBrand]: K };

/** Отпечаток номера документа, удостоверяющего личность. */
export type DocumentNumberFingerprint = Branded<'document_number'>;
/** Отпечаток грузинского личного номера. Опциональный атрибут, не ключ личности. */
export type PersonalNumberFingerprint = Branded<'personal_number'>;
/** Отпечаток реквизитов счёта (IBAN плюс банк). */
export type AccountFingerprint = Branded<'account'>;
/** Отпечаток устройства, сетевого адреса, телефона — сигналы связанности. */
export type DeviceFingerprint = Branded<'device'>;
export type NetworkAddressFingerprint = Branded<'network_address'>;
export type PhoneFingerprint = Branded<'phone'>;

function checked<K extends string>(kind: K, value: string): Branded<K> {
  if (!HEX_64.test(value)) {
    // В детали ошибки само значение не кладём: если сюда прилетела не-хеш
    // строка, это, вероятно, сырой номер документа, и он не должен попасть в лог.
    throw new ComplianceError(ComplianceErrorCode.fingerprintInvalid, { kind });
  }
  return value as Branded<K>;
}

export const documentNumberFingerprint = (value: string): DocumentNumberFingerprint =>
  checked('document_number', value);
export const personalNumberFingerprint = (value: string): PersonalNumberFingerprint =>
  checked('personal_number', value);
export const accountFingerprint = (value: string): AccountFingerprint => checked('account', value);
export const deviceFingerprint = (value: string): DeviceFingerprint => checked('device', value);
export const networkAddressFingerprint = (value: string): NetworkAddressFingerprint =>
  checked('network_address', value);
export const phoneFingerprint = (value: string): PhoneFingerprint => checked('phone', value);

/**
 * Порт вычисления отпечатка. Реализация — ключевое хеширование с перцем из
 * окружения; в чистом пакете её нет и быть не должно.
 */
export interface FingerprintPort {
  documentNumber(issuingCountry: string, type: string, rawNumber: string): DocumentNumberFingerprint;
  personalNumber(rawNumber: string): PersonalNumberFingerprint;
  account(rawIban: string): AccountFingerprint;
}

/** Короткая метка отпечатка для оператора и журнала: первые 8 знаков хеша. */
export function fingerprintLabel(value: string): string {
  return value.slice(0, 8);
}

/**
 * Журнальная проекция имени: алфавит, число знаков и первая буква каждой части.
 * Восстановить имя по ней нельзя, отличить «то же или другое» на глаз — можно.
 */
export interface NameDigest {
  readonly alphabet: string;
  readonly givenInitial: string;
  readonly givenLength: number;
  readonly familyInitial: string;
  readonly familyLength: number;
}

export function nameDigest(alphabet: string, given: string, family: string): NameDigest {
  return Object.freeze({
    alphabet,
    givenInitial: [...given].slice(0, 1).join(''),
    givenLength: [...given].length,
    familyInitial: [...family].slice(0, 1).join(''),
    familyLength: [...family].length,
  });
}
