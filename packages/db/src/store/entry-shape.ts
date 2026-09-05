import type {
  FeeAccrualDeclaration,
  FxExecution,
  JournalEntry,
  ShortfallFunding,
  TrancheSettlement,
} from '@sdelka/ledger';

/**
 * Форма записи журнала в базе — **зеркало формы записи в коде**, поле в поле.
 *
 * **Зачем отдельный модуль, а не список колонок в запросе.** Список колонок в
 * `INSERT` отвечает на вопрос «что мы пишем», но не отвечает на вопрос «всё ли
 * мы пишем». Ровно на этом и стоял отказ `db.entry.declaration_not_storable`:
 * `JournalEntry` несла четыре объявления, схема держала одно, и заметить это
 * можно было только сравнив два списка глазами. Здесь сравнение делает
 * компилятор: карта размечена **над самими типами учёта**, поэтому новое поле в
 * `FxExecution`, `FeeAccrualDeclaration`, `ShortfallFunding` или
 * `TrancheSettlement` роняет `pnpm typecheck`, а не первую вставку на проде.
 *
 * Вторую половину сверки — «в таблице нет колонки, о которой не знает код» —
 * держит тест дрейфа против живой схемы (`test/int/entry-columns.int.test.ts`),
 * а совпадение карты со списком колонок запросов — тест без базы
 * (`test/entry-shape.test.ts`). Три проверки закрывают три разных способа
 * разойтись, и ни одна не заменяет другую.
 */

/* ------------------------------------------------------------------------- */
/* Куда попадает значение поля                                               */
/* ------------------------------------------------------------------------- */

/**
 * Значение, выведенное из другой колонки, а не хранимое своей.
 *
 * Нужно ровно там, где две копии одного факта разошлись бы молча. Пара валют
 * курса (`FxRates.base`/`quote` и та же пара у каждого из трёх `FxRate`)
 * выводится из валют обеих ног: `fxExecution` пропускает объявление только
 * через `convertAtRate(source, rates.client, 'trunc')`, а тот отказывает, если
 * `source.currency <> rate.base` (`assertRateApplies`), и сверяет, что валюта
 * полученной суммы равна валюте `target`. Хранить эти коды второй раз значило
 * бы завести второй источник истины — тот же довод, по которому `account_code`
 * в `ledger_posting` вычисляется, а не заполняется приложением.
 *
 * Пометка обязательна и не пропускается молчанием: поле, у которого нет ни
 * колонки, ни пометки, карту не соберёт — компилятор потребует значение.
 */
export interface Derived {
  readonly derivedFrom: string;
}

export function derived(from: string): Derived {
  return Object.freeze({ derivedFrom: from });
}

/** Колонка таблицы либо ссылка на колонку, из которой значение выводится. */
export type Placement = string | Derived;

/**
 * Значения, у которых внутренней структуры нет: они ложатся в одну колонку
 * целиком. `null` и `undefined` здесь же — «поля нет» и «поле пусто» в базе
 * выражаются одним и тем же `NULL`.
 */
type Leaf = string | number | bigint | boolean | symbol | null | undefined;

/**
 * Карта значения: каждое поле либо колонка, либо снова карта.
 *
 * `[T] extends [Leaf]` в скобках намеренно: без них условный тип распределился
 * бы по объединению, и `string | null` дал бы объединение карт вместо одной.
 */
export type ColumnsOf<T> = [T] extends [Leaf]
  ? Placement
  : { readonly [K in keyof T]: ColumnsOf<T[K]> };

/* ------------------------------------------------------------------------- */
/* Карты                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Запись без объявлений и без проводок.
 *
 * Проводки исключены потому, что они лежат в другой таблице
 * (`sdelka.ledger_posting`) и размечены своей проекцией (`accountColumns`,
 * `attributionColumns`). Объявления вынесены отдельными картами: каждое — своё
 * значение домена, и разметка над ним обязана называть его поля, а не поля
 * записи.
 */
type EntryCore = Omit<
  JournalEntry,
  'postings' | 'settles' | 'converts' | 'accrues' | 'funds'
>;

export const CORE_COLUMNS: ColumnsOf<EntryCore> = Object.freeze({
  id: 'entry_id',
  occurredAt: 'occurred_at',
  kind: 'kind',
  memoKey: 'memo_key',
  correctsEntryId: 'corrects_entry_id',
});

/**
 * Объявление расчёта. Метка происхождения (`__trancheSettlement`) исключена:
 * это ambient-символ, значения у него нет ни в рантайме, ни в базе — он держит
 * невыразимость структурного литерала в TS и хранению не подлежит.
 */
type StoredSettlement = Omit<TrancheSettlement, '__trancheSettlement'>;

export const SETTLES_COLUMNS: ColumnsOf<StoredSettlement> = Object.freeze({
  deal: { dealId: 'settles_deal_id', trancheId: 'settles_tranche_id' },
  payer: 'settles_payer',
  recipient: 'settles_recipient',
  evidenceRef: 'settles_evidence_ref',
  ceiling: {
    maxShare: {
      numerator: 'settles_ceiling_numerator',
      denominator: 'settles_ceiling_denominator',
    },
  },
});

export const CONVERTS_COLUMNS: ColumnsOf<FxExecution> = Object.freeze({
  conversionId: 'converts_conversion_id',
  converted: {
    source: { currency: 'converts_source_currency', minor: 'converts_source_amount_minor' },
    target: { currency: 'converts_target_currency', minor: 'converts_target_amount_minor' },
    rates: {
      base: derived('converts_source_currency'),
      quote: derived('converts_target_currency'),
      client: {
        base: derived('converts_source_currency'),
        quote: derived('converts_target_currency'),
        value: {
          numerator: 'converts_client_rate_numerator',
          denominator: 'converts_client_rate_denominator',
        },
      },
      reference: {
        base: derived('converts_source_currency'),
        quote: derived('converts_target_currency'),
        value: {
          numerator: 'converts_reference_rate_numerator',
          denominator: 'converts_reference_rate_denominator',
        },
      },
      official: {
        base: derived('converts_source_currency'),
        quote: derived('converts_target_currency'),
        value: {
          numerator: 'converts_official_rate_numerator',
          denominator: 'converts_official_rate_denominator',
        },
      },
    },
    asOf: 'converts_as_of',
  },
});

export const ACCRUES_COLUMNS: ColumnsOf<FeeAccrualDeclaration> = Object.freeze({
  deal: { dealId: 'accrues_deal_id', trancheId: 'accrues_tranche_id' },
  fee: { currency: 'accrues_fee_currency', minor: 'accrues_fee_amount_minor' },
  tariffVersionId: 'accrues_tariff_version_id',
});

export const FUNDS_COLUMNS: ColumnsOf<ShortfallFunding> = Object.freeze({
  recognisedEntryId: 'funds_recognised_entry_id',
  owner: 'funds_owner',
  amount: { currency: 'funds_amount_currency', minor: 'funds_amount_minor' },
});

/**
 * Колонки, которых нет ни в одном значении домена, — поимённо и с причиной.
 * Список без причин превращается в место, куда дописывают всё подряд.
 */
export const NON_DOMAIN_COLUMNS: ReadonlyMap<string, string> = new Map([
  [
    'seq',
    // Порядок, в котором факты стали известны. Не то же самое, что `occurredAt`:
    // возраст открытой позиции по обмену и возраст транзита считаются по нему
    // (`0002_ledger.sql`), а две записи с одной меткой времени сделали бы
    // порядок случайным. Значение выдаёт база, домен его не знает.
    'порядок появления записи в журнале, выдаётся базой',
  ],
]);

/* ------------------------------------------------------------------------- */
/* Разбор карты                                                              */
/* ------------------------------------------------------------------------- */

function isDerived(value: unknown): value is Derived {
  return typeof value === 'object' && value !== null && 'derivedFrom' in value;
}

/** Колонки карты: хранимые — своим именем, выведенные — не своим и никаким. */
export function storedColumns(map: unknown): readonly string[] {
  if (typeof map === 'string') return [map];
  if (isDerived(map)) return [];
  if (typeof map !== 'object' || map === null) return [];
  return Object.values(map).flatMap((item) => storedColumns(item));
}

/** Колонки, на которые ссылаются выведенные поля. Тест проверяет, что они есть. */
export function derivedReferences(map: unknown): readonly string[] {
  if (isDerived(map)) return [map.derivedFrom];
  if (typeof map !== 'object' || map === null) return [];
  return Object.values(map).flatMap((item) => derivedReferences(item));
}

/** Все карты записи разом — в том порядке, в каком они объявлены выше. */
export const ENTRY_MAPS: readonly unknown[] = Object.freeze([
  CORE_COLUMNS,
  SETTLES_COLUMNS,
  CONVERTS_COLUMNS,
  ACCRUES_COLUMNS,
  FUNDS_COLUMNS,
]);

/**
 * Полный список колонок `sdelka.ledger_entry`, как его видит код: хранимые
 * колонки всех карт плюс те, у которых доменного источника нет.
 */
export const MIRRORED_ENTRY_COLUMNS: readonly string[] = Object.freeze([
  ...ENTRY_MAPS.flatMap((map) => storedColumns(map)),
  ...NON_DOMAIN_COLUMNS.keys(),
]);
