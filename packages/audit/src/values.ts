import { AuditError, AuditErrorCode } from './errors';
import { isSha256Hex, type Sha256Hex, sha256Hex } from './hash';

/**
 * Значения, которым разрешено попасть в тело записи.
 *
 * `FUNCTIONAL.md` инвариант 24 и `CORE.md` Ф11 сходятся в одном: журнал живёт
 * вечно и не редактируется, поэтому персональные данные, попавшие в него в
 * открытом виде, оттуда уже не убрать — ни по требованию субъекта, ни по
 * ошибке. Отсюда дисциплина `compliance/src/pii.ts`: номер документа, личный
 * номер, реквизиты счёта, телефон, адрес — только **отпечатки**.
 *
 * Отпечаток здесь — размеченный объект, а не «просто строка из 64 знаков».
 * Разница существенная: проверка `assertNoRawIdentifiers` обязана уметь
 * отличить отпечаток от сырого значения на структуре, а не угадывать по форме.
 */
declare const tokenBrand: unique symbol;

/**
 * Допустимая форма строки в журнале: технический ключ, идентификатор или ссылка.
 * Пробелов нет, `@` нет — значит, в журнал физически не входит ни свободный
 * текст (CLAUDE.md: ни одной строки пользовательского текста), ни адрес почты,
 * ни имя. Идентификатор оператора — непрозрачный ключ, а не логин-почта.
 */
const AUDIT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/+=~-]{0,511}$/u;

export type AuditToken = string & { readonly [tokenBrand]: 'token' };

export function auditToken(value: string): AuditToken {
  if (!AUDIT_TOKEN.test(value)) {
    // Значение в детали не кладём: если сюда прилетела строка со пробелами,
    // это, вероятно, имя или адрес.
    throw new AuditError(AuditErrorCode.tokenInvalid);
  }
  return value as AuditToken;
}

/* ------------------------------------------------------------------------- */
/* Отпечаток                                                                 */
/* ------------------------------------------------------------------------- */

/** Что именно отпечатано. Перечень закрыт: новый вид добавляется правкой кода. */
export const FINGERPRINT_SUBJECTS = [
  'document_number',
  'personal_number',
  'account',
  'device',
  'network_address',
  'phone',
  'name',
  'address',
  'raw_source',
] as const;
export type FingerprintSubject = (typeof FINGERPRINT_SUBJECTS)[number];

export interface AuditFingerprint {
  readonly kind: 'fingerprint';
  readonly of: FingerprintSubject;
  readonly digest: Sha256Hex;
}

/**
 * Вычисление отпечатка живёт снаружи: оно требует «перца» из окружения
 * (красная линия №12), а чистый пакет секретов не видит. Здесь только приём
 * готового значения — как `checked` в `compliance/src/pii.ts`.
 */
export function auditFingerprint(of: FingerprintSubject, digest: string): AuditFingerprint {
  return Object.freeze({ kind: 'fingerprint' as const, of, digest: sha256Hex(digest) });
}

/** Короткая метка для оператора: первые 8 знаков. Отпечаток по ней не восстановить. */
export function fingerprintLabel(value: AuditFingerprint): string {
  return value.digest.slice(0, 8);
}

/* ------------------------------------------------------------------------- */
/* Ссылка на сущность                                                        */
/* ------------------------------------------------------------------------- */

export const REF_SCOPES = [
  'deal',
  'tranche',
  'payout',
  'party',
  'beneficiary',
  'document',
  'evidence',
  'statement',
  'chain',
  /**
   * Учётная запись — субъект событий безопасности: вход, отказ во входе, смена
   * роли. Своим значением, а не `party`: сторона это участник сделки, и запись
   * «вход стороны party-3» через год прочиталась бы как действие по сделке.
   * Сотрудник вообще стороной не бывает, а входит именно он.
   *
   * Значение добавлено **в конец**: порядок меток зеркалится в
   * `sdelka.ref_scope`, а `ALTER TYPE ... ADD VALUE` умеет только дописывать в
   * конец (та же оговорка, что у `application_card` в `raw-source.ts`).
   */
  'account',
  /**
   * Управляемая настройка: тариф, наценка к курсу, перечень валют, пороги
   * (`BACKLOG.md` E16-4…E16-7). Субъект записи `setting_changed`.
   */
  'setting',
] as const;
export type RefScope = (typeof REF_SCOPES)[number];

export interface AuditRef {
  readonly kind: 'ref';
  readonly scope: RefScope;
  readonly id: AuditToken;
}

export function auditRef(scope: RefScope, id: string): AuditRef {
  return Object.freeze({ kind: 'ref' as const, scope, id: auditToken(id) });
}

export function sameRef(left: AuditRef, right: AuditRef): boolean {
  return left.scope === right.scope && left.id === right.id;
}

/* ------------------------------------------------------------------------- */
/* Сумма                                                                     */
/* ------------------------------------------------------------------------- */

const CURRENCY = /^[A-Z]{3}$/u;

/**
 * Сумма в журнале — целые минорные единицы и код валюты, `bigint`.
 * Красная линия №4: никаких сумм в плавающей точке. Тип здесь свой, а не
 * `Money` из `@sdelka/money`, потому что пакет аудита не берёт зависимостей;
 * источник истины по перечню валют — `@sdelka/money`.
 */
export interface AuditAmount {
  readonly kind: 'amount';
  readonly currency: string;
  readonly minor: bigint;
}

export function auditAmount(currency: string, minor: bigint): AuditAmount {
  if (!CURRENCY.test(currency)) {
    throw new AuditError(AuditErrorCode.currencyInvalid, { currency });
  }
  return Object.freeze({ kind: 'amount' as const, currency, minor });
}

/* ------------------------------------------------------------------------- */
/* Значение тела записи                                                      */
/* ------------------------------------------------------------------------- */

export type AuditValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | AuditFingerprint
  | AuditRef
  | AuditAmount
  | readonly AuditValue[]
  | AuditAttributes;

export interface AuditAttributes {
  readonly [key: string]: AuditValue;
}

/**
 * Значение управляемой настройки — то же, что `AuditValue`, **но не `null`**.
 *
 * Разница не косметическая. `null` в поле «прежнее значение» читается двояко:
 * «настройки не было» и «прежнее значение не заполнили». Второе получается
 * молчанием — ровно так же, как получались пустые отпечатки в отказе во входе
 * (`auth/src/events.ts`). Журнал не редактируется (красная линия №11), дописать
 * значение потом нельзя, поэтому «прежнего значения нет» выражено **отдельной
 * ветвью** `SettingChangedBody` (`change: 'introduced'`), а не пустым полем.
 */
export type AuditSettingValue = Exclude<AuditValue, null>;

/* ------------------------------------------------------------------------- */
/* Экран от сырых идентификаторов                                            */
/* ------------------------------------------------------------------------- */

/**
 * Поля, значения которых заведомо непрозрачны и произведены не нами: отпечатки,
 * хеши цепочки, токены метки времени и доказательства якоря. Их содержимое
 * персональных данных не несёт по построению, а под правила ниже попадает
 * случайно (base64 умеет выглядеть как IBAN).
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  'digest',
  'prevHash',
  'recordHash',
  'headHash',
  'token',
  'proof',
]);

/**
 * Второй рубеж после типов: грубые формы сырых идентификаторов.
 *
 * Первый рубеж — сам тип: реквизиты и номера входят в записи только как
 * `AuditFingerprint`. Эта проверка ловит то, что просочилось в свободное
 * строковое поле мимо типа. Она заведомо неполна — паспортный номер из семи
 * знаков под неё не подпадает, — и потому не заменяет типовую дисциплину, а
 * дополняет её (`CORE.md` Ф11, `FUNCTIONAL.md` инвариант 24).
 */
const RAW_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['iban', /[A-Z]{2}\d{2}[A-Z0-9]{11,30}/u],
  ['digit_run', /\d{9,}/u],
  ['phone', /\+\d{8,}/u],
];

function checkString(value: string, path: string, key: string | null): void {
  if (key !== null && OPAQUE_KEYS.has(key)) {
    return;
  }
  if (isSha256Hex(value)) {
    // Отпечаток или хеш, попавший в свободное поле: не сырое значение.
    return;
  }
  if (!AUDIT_TOKEN.test(value)) {
    throw new AuditError(AuditErrorCode.tokenInvalid, { path });
  }
  for (const [rule, pattern] of RAW_PATTERNS) {
    if (pattern.test(value)) {
      throw new AuditError(AuditErrorCode.rawIdentifier, { path, rule });
    }
  }
}

function walk(value: unknown, path: string, key: string | null): void {
  if (typeof value === 'string') {
    checkString(value, path, key);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${index}]`, key);
    });
    return;
  }
  const source = value as Record<string, unknown>;
  if (source['kind'] === 'fingerprint') {
    // Отпечаток — это и есть разрешённая форма хранения. Внутрь не смотрим.
    return;
  }
  for (const [childKey, child] of Object.entries(source)) {
    walk(child, `${path}.${childKey}`, childKey);
  }
}

export function assertNoRawIdentifiers(value: unknown, path: string = '$'): void {
  walk(value, path, null);
}
