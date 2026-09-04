import { levenshteinBp } from '@sdelka/compliance';
import { IntakeError, IntakeErrorCode } from './errors';
import { type IntakeReasonKey, INTAKE_REASON_KEYS } from './keys';
import type { IntakePolicy } from './policy';

/**
 * Референс платежа — `CORE.md` Ф4, `ROADMAP.md` И2.1.
 *
 * Главный факт про референс: он **теряется на корреспондентах и искажается при
 * ручном вводе**, а критерий автосверки на нём построен. Отсюда два решения:
 *
 *  1. **Референс уникален по траншу, а не по клиенту.** У клиента может быть
 *     несколько сделок, где он платит, и инструкции никогда не показываются
 *     «вообще» — только в контексте сделки.
 *  2. **Референс несёт контрольный знак.** Он отделяет «прочитали правильно» от
 *     «прочитали почти правильно» **до всякого обращения к базе сделок**, то
 *     есть до сопоставления. Без него искажённый референс чужой сделки
 *     неотличим от искажённого референса своей.
 *
 * Алфавит — `0-9A-Z`: всё, что переживает прохождение через назначение платежа,
 * верхний регистр банковских систем и ручной ввод оператора банка.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const RADIX = ALPHABET.length;

export const REFERENCE_PREFIX = 'SD';
export const DEAL_CODE_LENGTH = 8;
export const TRANCHE_CODE_LENGTH = 2;
export const REFERENCE_LENGTH =
  REFERENCE_PREFIX.length + DEAL_CODE_LENGTH + TRANCHE_CODE_LENGTH + 1;

export type PaymentReference = string & { readonly __paymentReference: unique symbol };

/**
 * Нормализация: верхний регистр, выброшено всё вне алфавита.
 *
 * Ровно то, что делают с назначением платежа банковские системы, и ровно то, что
 * с ним делает человек, переписывающий его в форму: пробелы, дефисы и слово
 * «оплата по» исчезают. Сравнивать до нормализации бессмысленно.
 */
export function normalizeReference(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/gu, '');
}

function codePointOf(character: string): number {
  const index = ALPHABET.indexOf(character);
  if (index < 0) {
    throw new IntakeError(IntakeErrorCode.referenceAlphabet, { character });
  }
  return index;
}

/**
 * Контрольный знак по схеме Луна с основанием 36.
 *
 * Схема выбрана как самая проверенная из простых: ловит **все** одиночные ошибки
 * знака и подавляющее большинство перестановок соседних — два самых частых
 * искажения при ручном переносе. Целочисленная, без единой операции с плавающей
 * точкой.
 */
export function referenceCheckCharacter(payload: string): string {
  let factor = 2;
  let total = 0;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    const character = payload[index];
    if (character === undefined) continue;
    let addend = factor * codePointOf(character);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / RADIX) + (addend % RADIX);
    total += addend;
  }
  const remainder = total % RADIX;
  const check = (RADIX - remainder) % RADIX;
  const result = ALPHABET[check];
  if (result === undefined) {
    throw new IntakeError(IntakeErrorCode.referenceAlphabet, { character: String(check) });
  }
  return result;
}

export interface ReferenceParts {
  readonly dealCode: string;
  readonly trancheCode: string;
}

function padCode(value: string, length: number, field: string): string {
  const normalized = normalizeReference(value);
  if (normalized.length === 0) {
    throw new IntakeError(IntakeErrorCode.referenceEmptySegment, { field });
  }
  if (normalized.length > length) return normalized.slice(normalized.length - length);
  return normalized.padStart(length, '0');
}

/**
 * Референс транша. Детерминированный: одна и та же пара кодов даёт один и тот же
 * референс, поэтому сопоставление не требует хранить выданное значение отдельно
 * от сделки.
 *
 * Коды сделки и транша приводятся к фиксированной ширине: разделителей в
 * референсе нет, потому что нормализация их выбросит, а разбор по фиксированным
 * позициям переживает и это.
 */
export function paymentReference(parts: ReferenceParts): PaymentReference {
  const deal = padCode(parts.dealCode, DEAL_CODE_LENGTH, 'dealCode');
  const tranche = padCode(parts.trancheCode, TRANCHE_CODE_LENGTH, 'trancheCode');
  const payload = `${REFERENCE_PREFIX}${deal}${tranche}`;
  return `${payload}${referenceCheckCharacter(payload)}` as PaymentReference;
}

export interface ParsedReference {
  readonly value: string;
  readonly parts: ReferenceParts;
  readonly checksumValid: boolean;
}

/**
 * Разбор строки из назначения платежа. `null` — на референс не похоже вовсе
 * (длина не та или знаки вне алфавита); это не то же самое, что «референс есть,
 * но контрольный знак не сошёлся» — второе возвращается с `checksumValid: false`
 * и остаётся кандидатом на искажение.
 */
export function parseReference(raw: string): ParsedReference | null {
  const value = normalizeReference(raw);
  if (value.length !== REFERENCE_LENGTH) return null;
  if (!value.startsWith(REFERENCE_PREFIX)) return null;
  const payload = value.slice(0, REFERENCE_LENGTH - 1);
  const check = value.slice(REFERENCE_LENGTH - 1);
  const dealStart = REFERENCE_PREFIX.length;
  return Object.freeze({
    value,
    parts: Object.freeze({
      dealCode: value.slice(dealStart, dealStart + DEAL_CODE_LENGTH),
      trancheCode: value.slice(dealStart + DEAL_CODE_LENGTH, REFERENCE_LENGTH - 1),
    }),
    checksumValid: referenceCheckCharacter(payload) === check,
  });
}

export const REFERENCE_MATCH_DEGREES = ['exact', 'damaged', 'foreign', 'absent'] as const;
export type ReferenceMatchDegree = (typeof REFERENCE_MATCH_DEGREES)[number];

export interface ReferenceMatch {
  readonly degree: ReferenceMatchDegree;
  /** Сходство с ожидаемым референсом в базисных пунктах. */
  readonly similarityBp: number;
  readonly checksumValid: boolean;
  readonly reasons: readonly IntakeReasonKey[];
}

/**
 * Сверка референса из выписки с ожидаемым.
 *
 * Четыре исхода, и три из них — не «нет»:
 *  · `exact`   — совпал после нормализации;
 *  · `damaged` — не совпал, но сходство выше порога: похоже на искажение при
 *                переносе, а не на чужой референс;
 *  · `foreign` — сходство ниже порога: это референс чего-то другого;
 *  · `absent`  — референса нет вовсе.
 *
 * `damaged` **не является основанием для сопоставления сам по себе** — он лишь
 * один из признаков в `matching.ts`, и его вес ниже точного совпадения. Иначе
 * искажение читалось бы как совпадение, и A3a («ноль отнесений к чужой сделке»)
 * ломался бы именно там, где сделки похожи.
 */
export function matchReference(
  expected: PaymentReference,
  rawFromStatement: string | null,
  policy: IntakePolicy,
): ReferenceMatch {
  if (rawFromStatement === null) {
    return Object.freeze({
      degree: 'absent',
      similarityBp: 0,
      checksumValid: false,
      reasons: Object.freeze([INTAKE_REASON_KEYS.referenceAbsent]),
    });
  }
  const observed = normalizeReference(rawFromStatement);
  if (observed.length === 0) {
    return Object.freeze({
      degree: 'absent',
      similarityBp: 0,
      checksumValid: false,
      reasons: Object.freeze([INTAKE_REASON_KEYS.referenceAbsent]),
    });
  }
  const parsed = parseReference(observed);
  const checksumValid = parsed !== null && parsed.checksumValid;
  const similarityBp = levenshteinBp(observed, expected);

  if (observed === (expected as string)) {
    return Object.freeze({
      degree: 'exact',
      similarityBp: 10_000,
      checksumValid: true,
      reasons: Object.freeze([INTAKE_REASON_KEYS.referenceExact]),
    });
  }

  const reasons: IntakeReasonKey[] = [];
  if (!checksumValid) reasons.push(INTAKE_REASON_KEYS.referenceChecksumFailed);

  if (similarityBp >= policy.matching.damagedReferenceThreshold.valueBp) {
    reasons.push(INTAKE_REASON_KEYS.referenceDamaged);
    return Object.freeze({
      degree: 'damaged',
      similarityBp,
      checksumValid,
      reasons: Object.freeze(reasons),
    });
  }

  reasons.push(INTAKE_REASON_KEYS.referenceAbsent);
  return Object.freeze({
    degree: 'foreign',
    similarityBp,
    checksumValid,
    reasons: Object.freeze(reasons),
  });
}
