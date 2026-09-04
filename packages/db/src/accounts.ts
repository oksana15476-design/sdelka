import {
  type Account,
  type AccountKind,
  type AccountNature,
  accountCode,
  accountNature,
  clientKey,
} from '@sdelka/ledger';

/**
 * По одному представителю на каждый вид счёта.
 *
 * **Зачем это здесь, а не таблица природы счетов, переписанная в базу.**
 * Справочник `sdelka.account_kind` в миграции `0001` обязан быть построчным
 * зеркалом `ACCOUNT_NATURE` из `packages/ledger/src/accounts.ts`. Сама таблица
 * оттуда не экспортируется, и просить учёт её экспортировать значило бы менять
 * публичную подпись чужого пакета ради удобства этого.
 *
 * Взамен здесь стоит по одному значению `Account` на вид, и природа каждого
 * **спрашивается у учёта** функцией `accountNature`. Тест дрейфа сравнивает
 * строки миграции с ответами этой функции: копии таблицы в `packages/db` нет,
 * есть вопрос к первоисточнику.
 *
 * Полнота держится типом: `Record<AccountKind, Account>` не собирается, если
 * учёт заведёт новый вид счёта, — `pnpm typecheck` падает здесь, а не молчит.
 * Это ровно тот приём, которым `ACCOUNT_NATURE` защищает сам себя.
 *
 * Значения-представители намеренно с разными параметрами (валюта, владелец,
 * сделка, транш, ключ конверсии): по ним же интеграционный тест сверяет
 * вычисляемую колонку `account_code` с `accountCode()`.
 */
const SAMPLE_CLIENT = clientKey('client-sample');
const SAMPLE_DEAL = 'deal-sample';
const SAMPLE_TRANCHE = 'tranche-sample';
const SAMPLE_CONVERSION = 'conversion-sample';

export const ACCOUNT_KIND_SAMPLES = {
  bank_nominal: { kind: 'bank_nominal', currency: 'GEL' },
  bank_operating: { kind: 'bank_operating', currency: 'GEL' },
  client_free: { kind: 'client_free', clientKey: SAMPLE_CLIENT },
  client_locked: {
    kind: 'client_locked',
    clientKey: SAMPLE_CLIENT,
    dealId: SAMPLE_DEAL,
    trancheId: SAMPLE_TRANCHE,
  },
  suspense_unidentified: { kind: 'suspense_unidentified' },
  fee_income: { kind: 'fee_income' },
  fx_income: { kind: 'fx_income' },
  service_income: { kind: 'service_income' },
  psp_fee_expense: { kind: 'psp_fee_expense' },
  oracle_cost_expense: { kind: 'oracle_cost_expense' },
  shortfall_expense: { kind: 'shortfall_expense' },
  unclaimed_liability: { kind: 'unclaimed_liability' },
  transit_writeoff: { kind: 'transit_writeoff' },
  fx_settlement: { kind: 'fx_settlement', conversionId: SAMPLE_CONVERSION },
  fee_receivable: { kind: 'fee_receivable' },
  transit_fee: { kind: 'transit_fee' },
  fx_accounting_diff: { kind: 'fx_accounting_diff' },
} as const satisfies Readonly<Record<AccountKind, Account>>;

export const ACCOUNT_KINDS: readonly AccountKind[] = Object.freeze(
  Object.keys(ACCOUNT_KIND_SAMPLES) as AccountKind[],
);

/**
 * Строка справочника `sdelka.account_kind` — ровно то, что база обязана знать о
 * виде счёта, чтобы классифицировать его **без перечня имён**.
 *
 * Перечень имён счетов в SQL — та же дыра, которая дважды стоила учёту
 * `isClientObligationAccount`: перечень всегда оказывается неполным, и неполнота
 * тихая. Поэтому представления сверки (`0008_views.sql`) джойнят этот
 * справочник, а не перечисляют коды.
 */
export interface AccountKindRow {
  readonly kind: AccountKind;
  readonly acctType: AccountNature['type'];
  readonly funds: 'client' | 'platform';
  /** Роль средств платформы. `null` у клиентских средств. */
  readonly platformRole: 'bank' | 'receivable' | 'transit' | 'result' | null;
  /** Происхождение файла клиентских средств. `null` у средств платформы. */
  readonly fileScope: 'owner_in_code' | 'in_attribution' | 'pooled' | null;
  /** Направление пула. `null`, если счёт пулом не является. */
  readonly poolDirection: 'intake' | 'terminal' | null;
  /** Обязан ли код счёта нести валюту. */
  readonly needsCurrency: boolean;
  /** Обязан ли код счёта нести владельца. */
  readonly needsClient: boolean;
  /** Обязан ли код счёта нести сделку и транш. */
  readonly needsTranche: boolean;
  /** Обязан ли код счёта нести ключ конверсии. */
  readonly needsConversion: boolean;
}

/**
 * Природа вида счёта, спрошенная у учёта, плюс форма его кода, прочитанная из
 * самого кода: наличие сегментов определяется тем, что `accountCode()` вернула
 * для представителя, а не отдельным перечнем.
 */
export function accountKindRow(kind: AccountKind): AccountKindRow {
  // Код представителя в справочник не кладём: он содержит подставные
  // идентификаторы. Форму кода держит вычисляемая колонка `account_code`, а
  // равенство её выражения функции `accountCode()` проверяет интеграционный
  // тест по каждому виду счёта.
  const sample: Account = ACCOUNT_KIND_SAMPLES[kind];
  const nature = accountNature(sample);
  return Object.freeze({
    kind,
    acctType: nature.type,
    funds: nature.funds,
    platformRole: nature.funds === 'platform' ? nature.role : null,
    fileScope: nature.funds === 'client' ? nature.file : null,
    poolDirection: nature.funds === 'client' && nature.file === 'pooled' ? nature.pool : null,
    needsCurrency: 'currency' in sample,
    needsClient: 'clientKey' in sample,
    needsTranche: 'dealId' in sample && 'trancheId' in sample,
    needsConversion: 'conversionId' in sample,
  });
}

/** Код счёта представителя вида — для интеграционной сверки с базой. */
export function sampleAccountCode(kind: AccountKind): string {
  return accountCode(ACCOUNT_KIND_SAMPLES[kind]);
}

export const ACCOUNT_KIND_ROWS: readonly AccountKindRow[] = Object.freeze(
  ACCOUNT_KINDS.map(accountKindRow),
);
