import { ComplianceError, ComplianceErrorCode } from './errors';
import { type ReasonKey, REASON_KEYS } from './keys';
import { type NameDigest, nameDigest } from './pii';

/**
 * Имена в трёх алфавитах — `docs/research/LOCALIZATION-NAMES.md`.
 *
 * Главный факт: **латинизация грузинского необратима**. В паспортной системе без
 * апострофов пять пар букв схлопываются в один латинский знак:
 * `t` ← თ·ტ, `k` ← ქ·კ, `p` ← ფ·პ, `ts` ← ც·წ, `ch` ← ჩ·ჭ. Типичная фамилия с
 * двумя такими знаками соответствует **четырём** грузинским написаниям.
 *
 * Отсюда три следствия, вшитые в этот файл:
 *  1. имя хранится во всех доступных алфавитах отдельными наблюдениями, ничего
 *     не перезаписывается;
 *  2. сравнение возвращает **степень совпадения с перечнем неоднозначностей**,
 *     а не булево;
 *  3. `NameMatch.sufficientAlone` имеет литеральный тип `false` — совпадение
 *     имени не является достаточным основанием ни для чего, и это утверждение
 *     проверяется компилятором, а не памятью разработчика.
 */
export const ALPHABETS = ['latin', 'cyrillic', 'georgian'] as const;
export type Alphabet = (typeof ALPHABETS)[number];

/** Откуда получена форма имени. Вес доказательства — свойство источника. */
export const NAME_SOURCES = [
  'identity_document',
  'registry_extract',
  'bank_account_holder',
  'client_declared',
  'sanctions_list',
] as const;
export type NameSource = (typeof NAME_SOURCES)[number];

/** Наблюдение: одна форма из одного источника. Строка в таблице, а не поле профиля. */
export interface NameObservation {
  readonly alphabet: Alphabet;
  readonly given: string;
  readonly family: string;
  readonly source: NameSource;
  /** Вес доказательства в базисных пунктах, 0–10000. */
  readonly evidenceWeightBp: number;
}

export function nameObservation(observation: NameObservation): NameObservation {
  if (observation.given.trim() === '' && observation.family.trim() === '') {
    throw new ComplianceError(ComplianceErrorCode.nameObservationEmpty, {
      source: observation.source,
    });
  }
  if (observation.evidenceWeightBp < 0 || observation.evidenceWeightBp > 10_000) {
    throw new ComplianceError(ComplianceErrorCode.basisPointsOutOfRange, {
      value: String(observation.evidenceWeightBp),
    });
  }
  return Object.freeze({ ...observation });
}

/** Набор наблюдений. Ничего не перезаписываем — только добавляем. */
export type NameObservations = readonly NameObservation[];

export function addNameObservation(
  observations: NameObservations,
  observation: NameObservation,
): NameObservations {
  return Object.freeze([...observations, nameObservation(observation)]);
}

/**
 * Латинская форма обязательна к заполнению для получателя выплаты: международный
 * стандарт платёжных сообщений поддерживает только латиницу. Это поле платежа,
 * а не одна из трёх версий интерфейса.
 */
export function latinObservation(observations: NameObservations): NameObservation | null {
  return observations.find((item) => item.alphabet === 'latin') ?? null;
}

/* ------------------------------------------------------------------------- */
/* Транслитерация                                                            */
/* ------------------------------------------------------------------------- */

/** Мхедрули → паспортная латиница (без апострофов). Здесь пары и схлопываются. */
const GEORGIAN_TO_PASSPORT: ReadonlyMap<string, string> = new Map([
  ['ა', 'a'], ['ბ', 'b'], ['გ', 'g'], ['დ', 'd'], ['ე', 'e'], ['ვ', 'v'],
  ['ზ', 'z'], ['თ', 't'], ['ი', 'i'], ['კ', 'k'], ['ლ', 'l'], ['მ', 'm'],
  ['ნ', 'n'], ['ო', 'o'], ['პ', 'p'], ['ჟ', 'zh'], ['რ', 'r'], ['ს', 's'],
  ['ტ', 't'], ['უ', 'u'], ['ფ', 'p'], ['ქ', 'k'], ['ღ', 'gh'], ['ყ', 'q'],
  ['შ', 'sh'], ['ჩ', 'ch'], ['ც', 'ts'], ['ძ', 'dz'], ['წ', 'ts'], ['ჭ', 'ch'],
  ['ხ', 'kh'], ['ჯ', 'j'], ['ჰ', 'h'],
]);

/**
 * Мхедрули → латиница с апострофами. Ключ, **сохраняющий** различие თ/ტ и
 * остальных четырёх пар. Второй производный ключ из исследования; по нему
 * различаются формы, которые паспортный ключ склеивает.
 */
const GEORGIAN_TO_APOSTROPHE: ReadonlyMap<string, string> = new Map([
  ...GEORGIAN_TO_PASSPORT,
  ['ტ', "t'"], ['კ', "k'"], ['პ', "p'"], ['წ', "ts'"], ['ჭ', "ch'"], ['ყ', "q'"],
]);

/**
 * Кириллическая передача грузинских имён → та же паспортная латиница.
 * `к` установлено исследованием как соответствующее **трём** грузинским буквам
 * (კ, ქ, ყ) — кириллица хуже латиницы. Остальные строки таблицы выведены по
 * аналогии с латинской парной таблицей и помечены как гипотеза.
 */
const CYRILLIC_TO_PASSPORT: ReadonlyMap<string, string> = new Map([
  ['а', 'a'], ['б', 'b'], ['в', 'v'], ['г', 'g'], ['д', 'd'], ['е', 'e'],
  ['ж', 'zh'], ['з', 'z'], ['и', 'i'], ['й', 'i'], ['к', 'k'], ['л', 'l'],
  ['м', 'm'], ['н', 'n'], ['о', 'o'], ['п', 'p'], ['р', 'r'], ['с', 's'],
  ['т', 't'], ['у', 'u'], ['ф', 'p'], ['х', 'kh'], ['ц', 'ts'], ['ч', 'ch'],
  ['ш', 'sh'], ['щ', 'sh'], ['ы', 'i'], ['э', 'e'], ['ю', 'iu'], ['я', 'ia'],
  ['ъ', ''], ['ь', ''],
]);

function mapText(text: string, table: ReadonlyMap<string, string>): string {
  let out = '';
  for (const character of text.toLowerCase()) {
    const mapped = table.get(character);
    out += mapped === undefined ? character : mapped;
  }
  return out;
}

/** Латиница приводится к общему пространству: нижний регистр, без диакритики и разделителей. */
function foldLatin(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z']/gu, '');
}

export function toPassportLatin(alphabet: Alphabet, text: string): string {
  switch (alphabet) {
    case 'georgian':
      return foldLatin(mapText(text, GEORGIAN_TO_PASSPORT));
    case 'cyrillic':
      return foldLatin(mapText(text, CYRILLIC_TO_PASSPORT));
    case 'latin':
      return foldLatin(text).replace(/'/gu, '');
  }
}

/**
 * Ключ с апострофами. Для грузинского наблюдения он различает თ/ტ; для латинского
 * и кириллического — совпадает с паспортным, потому что различие в них уже утрачено.
 * Это и есть точная формулировка необратимости: ключ есть, информации нет.
 */
export function toApostropheLatin(alphabet: Alphabet, text: string): string {
  return alphabet === 'georgian'
    ? foldLatin(mapText(text, GEORGIAN_TO_APOSTROPHE))
    : toPassportLatin(alphabet, text);
}

/* ------------------------------------------------------------------------- */
/* Неоднозначность                                                           */
/* ------------------------------------------------------------------------- */

/** Схлопывающиеся латинские знаки: сколько грузинских букв даёт каждый. */
const COLLAPSING_GRAPHEMES: ReadonlyMap<string, readonly string[]> = new Map([
  // Перечни заморожены: они не копируются, а уходят в `NameAmbiguity` по ссылке,
  // и правка через отчёт меняла бы таблицу латинизации для всех последующих
  // сравнений в процессе.
  ['t', Object.freeze(['თ', 'ტ'])],
  ['k', Object.freeze(['ქ', 'კ'])],
  ['p', Object.freeze(['ფ', 'პ'])],
  ['ts', Object.freeze(['ც', 'წ'])],
  ['ch', Object.freeze(['ჩ', 'ჭ'])],
]);

/** Многознаковые графемы разбираются жадно: `kh` — это ხ, а не `k` + `h`. */
const DIGRAPHS = ['zh', 'gh', 'sh', 'ch', 'ts', 'dz', 'kh'] as const;

export function latinGraphemes(text: string): readonly string[] {
  const graphemes: string[] = [];
  let index = 0;
  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    if ((DIGRAPHS as readonly string[]).includes(pair)) {
      graphemes.push(pair);
      index += 2;
      continue;
    }
    graphemes.push(text.slice(index, index + 1));
    index += 1;
  }
  return graphemes;
}

export interface NameAmbiguity {
  /** Латинская графема, в которой утрачено различие. */
  readonly grapheme: string;
  /** Позиция графемы в разобранной форме — чтобы оператор видел, где именно. */
  readonly position: number;
  /** Грузинские буквы, которые в неё схлопнулись. */
  readonly georgianCandidates: readonly string[];
}

export interface LatinAmbiguityReport {
  readonly ambiguities: readonly NameAmbiguity[];
  /** Сколько грузинских написаний допускает эта латинская форма. */
  readonly georgianSpellingCount: number;
}

/**
 * Сколько грузинских написаний соответствует латинской форме.
 * Произведение числа кандидатов по каждой схлопнувшейся графеме: `Tatishvili`
 * даёт 2×2 = 4 — ровно то, что измерено в исследовании.
 */
export function latinAmbiguity(passportLatin: string): LatinAmbiguityReport {
  const ambiguities: NameAmbiguity[] = [];
  let count = 1;
  latinGraphemes(passportLatin).forEach((grapheme, position) => {
    const candidates = COLLAPSING_GRAPHEMES.get(grapheme);
    if (candidates === undefined) return;
    ambiguities.push(Object.freeze({ grapheme, position, georgianCandidates: candidates }));
    count *= candidates.length;
  });
  return Object.freeze({ ambiguities: Object.freeze(ambiguities), georgianSpellingCount: count });
}

/* ------------------------------------------------------------------------- */
/* Признаки сходства                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Все три признака считаются в базисных пунктах целыми числами. Фонетические
 * алгоритмы не применяются: они построены под английские фамилии и прямо
 * предупреждают о многобайтовых кодировках.
 */
export function levenshteinDistance(left: string, right: string): number {
  let previous: number[] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = new Array<number>(right.length + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

export function levenshteinBp(left: string, right: string): number {
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 10_000;
  const distance = levenshteinDistance(left, right);
  return Math.max(0, Math.floor(((longest - distance) * 10_000) / longest));
}

function trigrams(text: string): ReadonlySet<string> {
  const padded = `  ${text} `;
  const set = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    set.add(padded.slice(index, index + 3));
  }
  return set;
}

export function trigramBp(left: string, right: string): number {
  if (left === '' && right === '') return 10_000;
  const a = trigrams(left);
  const b = trigrams(right);
  let intersection = 0;
  for (const gram of a) if (b.has(gram)) intersection += 1;
  const union = a.size + b.size - intersection;
  if (union === 0) return 10_000;
  return Math.floor((intersection * 10_000) / union);
}

/** Джаро в базисных пунктах, целочисленно: BigInt, чтобы не было плавающей точки. */
function jaroBp(left: string, right: string): number {
  if (left === '' && right === '') return 10_000;
  if (left === '' || right === '') return 0;
  const window = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatched = new Array<boolean>(left.length).fill(false);
  const rightMatched = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let i = 0; i < left.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(right.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (rightMatched[j] === true) continue;
      if (left[i] !== right[j]) continue;
      leftMatched[i] = true;
      rightMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (leftMatched[i] !== true) continue;
    while (rightMatched[k] !== true) k += 1;
    if (left[i] !== right[k]) transpositions += 1;
    k += 1;
  }
  const halfTranspositions = BigInt(Math.floor(transpositions / 2));
  const m = BigInt(matches);
  const l1 = BigInt(left.length);
  const l2 = BigInt(right.length);
  const numerator = 10_000n * (m * m * l2 + m * m * l1 + (m - halfTranspositions) * l1 * l2);
  const denominator = 3n * l1 * l2 * m;
  return Number(numerator / denominator);
}

export function jaroWinklerBp(left: string, right: string): number {
  const jaro = jaroBp(left, right);
  let prefix = 0;
  while (prefix < 4 && prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  // Коэффициент Винклера 0,1 — целочисленно это деление на 10.
  return Math.min(10_000, jaro + Math.floor((prefix * (10_000 - jaro)) / 10));
}

export interface NameFeatures {
  readonly levenshteinBp: number;
  readonly trigramBp: number;
  readonly jaroWinklerBp: number;
}

/** Веса ансамбля в процентах, в сумме 100. Объяснимость важнее точности. */
export interface NameFeatureWeights {
  readonly levenshteinPercent: number;
  readonly trigramPercent: number;
  readonly jaroWinklerPercent: number;
}

export const DEFAULT_NAME_FEATURE_WEIGHTS: NameFeatureWeights = Object.freeze({
  levenshteinPercent: 30,
  trigramPercent: 30,
  jaroWinklerPercent: 40,
});

export function combineFeatures(features: NameFeatures, weights: NameFeatureWeights): number {
  const total =
    weights.levenshteinPercent + weights.trigramPercent + weights.jaroWinklerPercent;
  if (total !== 100) {
    throw new ComplianceError(ComplianceErrorCode.basisPointsOutOfRange, { total: String(total) });
  }
  return Math.floor(
    (features.levenshteinBp * weights.levenshteinPercent +
      features.trigramBp * weights.trigramPercent +
      features.jaroWinklerBp * weights.jaroWinklerPercent) /
      100,
  );
}

/* ------------------------------------------------------------------------- */
/* Сравнение                                                                 */
/* ------------------------------------------------------------------------- */

export const NAME_MATCH_DEGREES = [
  'not_comparable',
  'none',
  'weak',
  'strong',
  'identical_after_latinization',
  'identical_in_source_alphabet',
] as const;
export type NameMatchDegree = (typeof NAME_MATCH_DEGREES)[number];

export interface ComparedPair {
  readonly left: NameDigest;
  readonly right: NameDigest;
  readonly leftPassportLatin: string;
  readonly rightPassportLatin: string;
  readonly sameSourceAlphabet: boolean;
}

export interface NameMatch {
  readonly degree: NameMatchDegree;
  readonly scoreBp: number;
  readonly features: NameFeatures;
  readonly best: ComparedPair | null;
  /** Явный перечень мест, где различие утрачено. Оператору показывается он, а не число. */
  readonly ambiguities: readonly NameAmbiguity[];
  /** Сколько грузинских написаний допускает совпавшая латинская форма. */
  readonly georgianSpellingCount: number;
  readonly reasons: readonly ReasonKey[];
  /**
   * Совпадение имени не является достаточным основанием ни для чего. Тип
   * литеральный: никакой вызов не может собрать `NameMatch`, утверждающий обратное.
   */
  readonly sufficientAlone: false;
}

export interface NameComparisonOptions {
  /** Порог «сильного» совпадения в базисных пунктах. Разный для разных задач. */
  readonly strongThresholdBp: number;
  readonly weights?: NameFeatureWeights;
}

function fullForm(observation: NameObservation): string {
  return `${observation.given} ${observation.family}`.trim();
}

export function compareNames(
  left: NameObservations,
  right: NameObservations,
  options: NameComparisonOptions,
): NameMatch {
  const weights = options.weights ?? DEFAULT_NAME_FEATURE_WEIGHTS;
  const empty: NameFeatures = Object.freeze({ levenshteinBp: 0, trigramBp: 0, jaroWinklerBp: 0 });
  if (left.length === 0 || right.length === 0) {
    return Object.freeze({
      degree: 'not_comparable',
      scoreBp: 0,
      features: empty,
      best: null,
      ambiguities: Object.freeze([]),
      georgianSpellingCount: 1,
      reasons: Object.freeze([REASON_KEYS.nameNotComparable]),
      sufficientAlone: false,
    });
  }

  let bestScore = -1;
  let bestFeatures: NameFeatures = empty;
  let bestPair: ComparedPair | null = null;
  let bestExactInSourceAlphabet = false;

  for (const a of left) {
    for (const b of right) {
      const sameAlphabet = a.alphabet === b.alphabet;
      // В одном алфавите сравниваем исходные формы, иначе — паспортное пространство.
      const leftKey = sameAlphabet ? fullForm(a).toLowerCase() : toPassportLatin(a.alphabet, fullForm(a));
      const rightKey = sameAlphabet ? fullForm(b).toLowerCase() : toPassportLatin(b.alphabet, fullForm(b));
      const features: NameFeatures = Object.freeze({
        levenshteinBp: levenshteinBp(leftKey, rightKey),
        trigramBp: trigramBp(leftKey, rightKey),
        jaroWinklerBp: jaroWinklerBp(leftKey, rightKey),
      });
      const score = combineFeatures(features, weights);
      const exactInSourceAlphabet = sameAlphabet && leftKey === rightKey && leftKey !== '';
      const better =
        score > bestScore || (score === bestScore && exactInSourceAlphabet && !bestExactInSourceAlphabet);
      if (!better) continue;
      bestScore = score;
      bestFeatures = features;
      bestExactInSourceAlphabet = exactInSourceAlphabet;
      bestPair = Object.freeze({
        left: nameDigest(a.alphabet, a.given, a.family),
        right: nameDigest(b.alphabet, b.given, b.family),
        leftPassportLatin: toPassportLatin(a.alphabet, fullForm(a)),
        rightPassportLatin: toPassportLatin(b.alphabet, fullForm(b)),
        sameSourceAlphabet: sameAlphabet,
      });
    }
  }

  const pair = bestPair;
  const ambiguityReport =
    pair === null ? { ambiguities: [], georgianSpellingCount: 1 } : latinAmbiguity(pair.leftPassportLatin);
  const reasons: ReasonKey[] = [REASON_KEYS.nameEvidenceInsufficientAlone];
  if (ambiguityReport.ambiguities.length > 0) {
    reasons.push(REASON_KEYS.nameLatinizationIrreversible);
  }
  if (pair !== null && (pair.left.alphabet === 'cyrillic' || pair.right.alphabet === 'cyrillic')) {
    reasons.push(REASON_KEYS.nameCyrillicMoreAmbiguous);
  }

  const identicalLatin = pair !== null && pair.leftPassportLatin === pair.rightPassportLatin;
  let degree: NameMatchDegree;
  if (bestExactInSourceAlphabet) degree = 'identical_in_source_alphabet';
  else if (identicalLatin) degree = 'identical_after_latinization';
  else if (bestScore >= options.strongThresholdBp) degree = 'strong';
  else if (bestScore > 0) degree = 'weak';
  else degree = 'none';

  return Object.freeze({
    degree,
    scoreBp: Math.max(0, bestScore),
    features: bestFeatures,
    best: pair,
    ambiguities: Object.freeze(ambiguityReport.ambiguities),
    georgianSpellingCount: ambiguityReport.georgianSpellingCount,
    reasons: Object.freeze(reasons),
    sufficientAlone: false,
  });
}
