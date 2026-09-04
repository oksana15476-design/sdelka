import type { CurrencyCode } from '@sdelka/money';
import { LedgerError, LedgerErrorCode } from './errors';

/**
 * Ключ счёта клиента.
 *
 * FUNCTIONAL.md §2.1 и §3.1: **один клиент — один счёт на все его сделки в любых
 * ролях**, и ключом этого счёта является ключ личности, а не пара «сделка +
 * роль». Роль — свойство участия в сделке, а не человека, поэтому в ключе счёта
 * её нет вовсе.
 *
 * Тип брендированный: сырую строку на место владельца подставить нельзя, иначе
 * `dealId` и ключ личности начинают путешествовать по одним и тем же аргументам.
 *
 * Форма ключа личности (`страна:тип:отпечаток`, `packages/compliance`) сюда не
 * попадает: она содержит двоеточие — разделитель кода счёта — и несёт семантику
 * персональных данных, которой в учёте не место. Перевод одного в другое —
 * забота compliance, ledger видит только непрозрачный идентификатор.
 */
export type ClientKey = string & { readonly __clientKey: unique symbol };

const CLIENT_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export function clientKey(value: string): ClientKey {
  if (!CLIENT_KEY_PATTERN.test(value)) {
    throw new LedgerError(LedgerErrorCode.accountInvalidIdentifier, { field: 'clientKey', value });
  }
  return value as ClientKey;
}

/** План счетов — FUNCTIONAL.md §3.1 и §4.1. Счёт — значение, а не свободная строка. */
export type Account =
  | { readonly kind: 'bank_nominal'; readonly currency: CurrencyCode }
  | { readonly kind: 'bank_operating'; readonly currency: CurrencyCode }
  // Свободная часть счёта клиента: его собственные и отзывные деньги вне сделок.
  | { readonly kind: 'client_free'; readonly clientKey: ClientKey }
  // Запертая часть: обязательство перед тем же клиентом под конкретный транш.
  // Владелец и транш вместе входят в код счёта — именно этим «заперто под сделку
  // А» отличается от «заперто под сделку Б» структурно, а не проверкой.
  | {
      readonly kind: 'client_locked';
      readonly clientKey: ClientKey;
      readonly dealId: string;
      readonly trancheId: string;
    }
  | { readonly kind: 'suspense_unidentified' }
  | { readonly kind: 'fee_income' }
  | { readonly kind: 'fx_income' }
  | { readonly kind: 'service_income' }
  | { readonly kind: 'psp_fee_expense' }
  | { readonly kind: 'oracle_cost_expense' }
  | { readonly kind: 'shortfall_expense' }
  | { readonly kind: 'unclaimed_liability' }
  // Деньги в пути между номинальным и операционным счётом при списании
  // невостребованного (§3.1, «два момента, а не один»). В плане счетов
  // документа он был с самого начала, в коде его не было: списание собиралось
  // одной записью прямо на операционный счёт, и обязательство перед клиентом
  // на время перевода оставалось без единого актива за ним.
  | { readonly kind: 'transit_writeoff' }
  // Клиентские средства у валютного контрагента: исходная валюта ушла с
  // номинального счёта, встречная ещё не пришла. Конвертация — операция с
  // внешним контрагентом, а не превращение одной валюты в другую внутри нашего
  // журнала; без этого счёта обе стороны обмена создавала одна запись, и
  // покрытие после неё тождественно равнялось единице.
  //
  // **Владелец и ключ конверсии входят в код счёта — оба.** Прежде счёт был
  // один на все обмены всех клиентов; ключ конверсии развёл обмены, но клиента
  // в код так и не внёс, а уникальность ключа не проверялась нигде. Два
  // клиента, назвавшие свой обмен одинаково (`x1` — обычное имя, приходящее из
  // внешней системы), получали **один и тот же счёт**: их позиции складывались,
  // и незакрытая позиция одного гасилась встречной ногой другого. Это ровно
  // то, от чего защищает `client_locked`, где владелец в коде стоит с самого
  // начала: файл — свойство кода счёта, а не соглашения о вызове.
  //
  // Опаснее, чем выглядит: открытая позиция — **единственное**, чем ловится
  // «встречная валюта не поставлена» (§3.3, `fxPositionOpen`). Ни отрицательным
  // остатком, ни покрытием это состояние не выражается, поэтому слияние двух
  // позиций в одну не оставляло следа нигде.
  | {
      readonly kind: 'fx_settlement';
      readonly clientKey: ClientKey;
      readonly conversionId: string;
    }
  // Комиссия **начислена**: доход признан, из платежа ещё не удержан
  // (FUNCTIONAL.md §4.6, «начислено против удержано»; CORE.md Ф16). Требование
  // платформы, а не деньги: на нём стоит первый из двух встречных фактов, без
  // которых удержание выглядит недопереводом клиентских средств (§4.1).
  | { readonly kind: 'fee_receivable' }
  // Комиссия **удержана**, но перевод на операционный счёт ещё не дошёл. Та же
  // конструкция, что и `transit:writeoff`: номинальный счёт в одном банке,
  // операционный в другом, межбанковский перевод занимает день-два (§3.2).
  // Без этого счёта «удержано» и «получено» были одной строкой — ровно то, что
  // CORE.md Ф10 и Ф16 запрещают.
  | { readonly kind: 'transit_fee' }
  | { readonly kind: 'fx_accounting_diff' };

export type AccountKind = Account['kind'];

export type AccountType = 'asset' | 'liability' | 'income' | 'expense';

/**
 * Чьи это деньги. Красная линия №2 и покрытие (CORE.md Ф10) держатся на этом
 * различении, поэтому оно свойство счёта, а не соглашение об именовании.
 */
export type FundsOwnership = 'client' | 'platform';

/**
 * Чем счёт платформы является **физически**. Объявлять обязан каждый счёт
 * платформы, и это не украшение: три разных правила спрашивают «настоящие ли
 * это деньги», и до появления роли каждое отвечало «актив платформы», то есть
 * одинаково для банковского счёта и для требования.
 *
 * - `bank` — счёт в банке. Настоящие деньги, которые можно перевести.
 * - `receivable` — требование платформы к кому-то. Деньгами не является:
 *   довнести ими недостачу клиента нельзя, обеспечить ими чужое обязательство
 *   нельзя, а признать против них доход — можно (это и есть начисление).
 * - `transit` — собственные деньги платформы в пути между её счетами.
 * - `result` — доход или расход, счёт результата, а не средств.
 */
export type PlatformFundsRole = 'bank' | 'receivable' | 'transit' | 'result';

/**
 * Откуда у клиентских денег берётся **файл** — та единица, внутри которой
 * считается обеспечение и между которыми красная линия №1 запрещает переливы.
 *
 * - `owner_in_code` — файл читается из самого кода счёта: свободная часть даёт
 *   файл клиента, запертая — файл транша;
 * - `in_attribution` — файл приносит отнесение проводки: так устроен
 *   номинальный счёт, на котором лежат деньги всех файлов сразу;
 * - `pooled` — клиентские деньги **вне файлов**: владельца ещё (или уже) нет.
 *   Пул обязан объявить своё направление, см. `PoolDirection`.
 */
export type FundsFileScope = 'owner_in_code' | 'in_attribution' | 'pooled';

/**
 * Направление пула — единственная причина, по которой пулы вообще различаются.
 *
 * - `intake` — вход в учёт: деньги попадают сюда снаружи, без владельца, и
 *   уходят отсюда только к владельцу (опознание). Обязательство перед уже
 *   известным клиентом сюда не возвращается никогда: это первый шаг
 *   двухзаписной отмывки.
 * - `terminal` — выход: обязательство перед известным клиентом закрывается
 *   сюда (списание невостребованного, §3.1, случай Б) и **обратно к клиенту не
 *   выходит**, пока не отвечен вопрос §3.1 «порядок обращения с
 *   невостребованными средствами — [открыто]».
 */
export type PoolDirection = 'intake' | 'terminal';

/**
 * Природа счёта: тип, принадлежность средств и — для клиентских денег —
 * происхождение файла.
 *
 * **Это союз, а не запись с необязательными полями, и в этом весь смысл.**
 * Прежняя защита красной линии №1 стояла на перечнях имён счетов
 * (`isClientObligationAccount` перечислял три вида), и перечень дважды
 * оказывался неполным: сначала через него прошла отмывка через
 * `suspense:unidentified`, потом — ровно та же через `unclaimed:liability`,
 * которого в перечне не было. Перечень всегда имеет дырку, и дырка тихая:
 * тесты остаются зелёными.
 *
 * Теперь принадлежность к клиентским обязательствам **выводится** из
 * объявленной природы счёта, а объявить её обязан каждый вид счёта: таблица
 * `ACCOUNT_NATURE` — `Record<AccountKind, AccountNature>`, и вид счёта без
 * записи в ней не компилируется. Объявив `funds: 'client'`, счёт обязан
 * назвать и файл; объявив `file: 'pooled'` — направление пула. Добавить счёт
 * мимо защиты стало ошибкой компиляции, а не тихой дырой.
 */
export type AccountNature = {
  readonly type: AccountType;
} & (
  | { readonly funds: 'platform'; readonly role: PlatformFundsRole }
  | { readonly funds: 'client'; readonly file: 'owner_in_code' | 'in_attribution' }
  | { readonly funds: 'client'; readonly file: 'pooled'; readonly pool: PoolDirection }
);

const ACCOUNT_NATURE = {
  // Номинальный счёт — актив, на котором лежат чужие деньги всех файлов сразу.
  // Именно он сопоставляется с обязательствами при проверке покрытия, а файл
  // конкретной проводки приносит её отнесение.
  bank_nominal: { type: 'asset', funds: 'client', file: 'in_attribution' },
  bank_operating: { type: 'asset', funds: 'platform', role: 'bank' },
  client_free: { type: 'liability', funds: 'client', file: 'owner_in_code' },
  client_locked: { type: 'liability', funds: 'client', file: 'owner_in_code' },
  // Непознанное поступление: владельца ещё нет (§3.3, шаг 1). Вход, и только.
  suspense_unidentified: { type: 'liability', funds: 'client', file: 'pooled', pool: 'intake' },
  fee_income: { type: 'income', funds: 'platform', role: 'result' },
  fx_income: { type: 'income', funds: 'platform', role: 'result' },
  service_income: { type: 'income', funds: 'platform', role: 'result' },
  psp_fee_expense: { type: 'expense', funds: 'platform', role: 'result' },
  oracle_cost_expense: { type: 'expense', funds: 'platform', role: 'result' },
  // Случай А из §3.1: недостача, покрытая платформой. Признаётся в момент
  // поступления, состоянием транша не является. Деньги платформы.
  shortfall_expense: { type: 'expense', funds: 'platform', role: 'result' },
  // Случай Б: невостребованные средства. Обязательство, а не доход. Признать
  // их доходом было бы удобно и, возможно, незаконно — порядок обращения
  // с ними помечен в §3.1 как [открыто], до ответа юриста это долг. Пул
  // терминальный: обязательство закрывается сюда и обратно не выходит.
  unclaimed_liability: { type: 'liability', funds: 'client', file: 'pooled', pool: 'terminal' },
  // Транзит списания — те же клиентские деньги, только в пути между банками.
  // Актив того же пула, что и долг, который он обеспечивает.
  transit_writeoff: { type: 'asset', funds: 'client', file: 'pooled', pool: 'terminal' },
  // Средства у валютного контрагента — те же чужие деньги, только не на нашем
  // счёте. Клиентский актив: деньги уходят из файла клиента и в него же
  // возвращаются встречной валютой, поэтому покрытие между моментами обмена не
  // проваливается и не завышается.
  //
  // Файл — **из кода счёта**, а не из отнесения. С владельцем в коде это уже не
  // выбор: счёт, объявивший «файл приносит отнесение», принимает любое
  // отнесение, и проводка по счёту обмена клиента A, отнесённая к клиенту B,
  // прошла бы `assertAttribution` беспрепятственно — то самое расхождение кода
  // и файла, ради закрытия которого владелец в код и вносится. Обеспечение при
  // этом считается ровно как прежде: `clientAccountFile` у счёта без транша
  // возвращает файл клиента — то же значение, которое раньше приезжало
  // отнесением.
  fx_settlement: { type: 'asset', funds: 'client', file: 'owner_in_code' },
  // Требование платформы по начисленной комиссии. Роль `receivable`, а не
  // `bank`: этот актив не является деньгами, и правила, которым нужны именно
  // деньги (довнесение недостачи, обеспечение невостребованных), его не видят.
  fee_receivable: { type: 'asset', funds: 'platform', role: 'receivable' },
  // Удержанная комиссия в пути на операционный счёт. Деньги платформы — на
  // номинальном счёте её уже нет (красная линия №2), на операционном ещё нет.
  transit_fee: { type: 'asset', funds: 'platform', role: 'transit' },
  // FUNCTIONAL.md §3.1 помечает учётную курсовую разницу как «расход/доход»:
  // она бывает обеих знаков. Тип счёта в плане один, поэтому знак несёт
  // направление проводки, а не отдельный счёт: кредитовый остаток на этом
  // счёте читается как доход. Разводить на два счёта — решение владельца,
  // здесь его нет. Это не наш спред: спред и разница разведены типами в money
  // (FUNCTIONAL.md §4.5, CORE.md Ф5), поэтому средства платформы.
  fx_accounting_diff: { type: 'expense', funds: 'platform', role: 'result' },
} as const satisfies Readonly<Record<AccountKind, AccountNature>>;

type Assert<T extends true> = T;

type KindsWithNature<Shape> = {
  [K in AccountKind]: (typeof ACCOUNT_NATURE)[K] extends Shape ? K : never;
}[AccountKind];

/**
 * Счёт, объявивший «владелец в коде», обязан нести владельца в значении. Иначе
 * `clientAccountOwner` возвращал бы `null` для счёта, который по объявлению
 * владельца имеет, и движение между владельцами снова стало бы невидимым.
 */
export type AssertOwnerInCodeCarriesOwner = Assert<
  Extract<Account, { kind: KindsWithNature<{ file: 'owner_in_code' }> }> extends {
    readonly clientKey: ClientKey;
  }
    ? true
    : false
>;

/**
 * Обязательство перед клиентом не может брать файл из отнесения проводки:
 * отнесение задаёт тот, кто строит запись, и обязательство, чей файл назначается
 * извне, ничем не привязано к владельцу. Файл обязательства либо в коде счёта,
 * либо его нет вовсе (пул).
 */
export type AssertObligationFileIsNotAttributed = Assert<
  KindsWithNature<{ type: 'liability'; funds: 'client'; file: 'in_attribution' }> extends never
    ? true
    : false
>;

/**
 * Счёт результата — это доход или расход, и наоборот. Роль `result` на активе
 * платформы означала бы, что признание дохода можно подпереть чем угодно, а
 * роль средств на счёте дохода — что доход можно раздать как деньги.
 */
export type AssertPlatformResultRoleMatchesType = Assert<
  KindsWithNature<{ funds: 'platform'; role: 'result' }> extends KindsWithNature<{
    type: 'income' | 'expense';
  }>
    ? KindsWithNature<{ type: 'income' | 'expense' }> extends KindsWithNature<{
        funds: 'platform';
        role: 'result';
      }>
      ? true
      : false
    : false
>;

export function accountNature(account: Account): AccountNature {
  return ACCOUNT_NATURE[account.kind];
}

export function accountType(account: Account): AccountType {
  return ACCOUNT_NATURE[account.kind].type;
}

export function fundsOwnership(account: Account): FundsOwnership {
  return ACCOUNT_NATURE[account.kind].funds;
}

export function isClientFundsAccount(account: Account): boolean {
  return fundsOwnership(account) === 'client';
}

/** Роль счёта платформы. `null` — счёт не средств платформы. */
export function platformFundsRole(account: Account): PlatformFundsRole | null {
  const nature = ACCOUNT_NATURE[account.kind];
  return nature.funds === 'platform' ? nature.role : null;
}

/**
 * Настоящие деньги платформы: остаток на её банковском счёте.
 *
 * Отдельно от «актив платформы» намеренно. Требование по начисленной комиссии
 * — тоже актив платформы, но перевести его нельзя: довнесение недостачи
 * (§3.1, случай А, момент 2) требует денег, ушедших со счёта, а не списанного
 * требования. До появления роли оба счёта отвечали на этот вопрос одинаково.
 */
export function isPlatformBankAccount(account: Account): boolean {
  return platformFundsRole(account) === 'bank';
}

/** Требование платформы: начисленная, но ещё не удержанная комиссия. */
export function isPlatformReceivableAccount(account: Account): boolean {
  return platformFundsRole(account) === 'receivable';
}

/**
 * Ключ конверсии, если счёт принадлежит конкретному обмену. `null` — счёт к
 * обмену отношения не имеет.
 */
export function conversionOfAccount(account: Account): string | null {
  return account.kind === 'fx_settlement' ? account.conversionId : null;
}

/**
 * Актив, на котором физически лежат клиентские средства.
 *
 * Выводится, а не перечисляется: клиентские деньги плюс тип «актив». Новый
 * счёт, объявивший себя клиентским активом, попадает сюда сам.
 */
export function isClientCustodyAccount(account: Account): boolean {
  const nature = ACCOUNT_NATURE[account.kind];
  return nature.funds === 'client' && nature.type === 'asset';
}

/**
 * Обязательство перед клиентом — любое: и запертое под транш, и свободное, и
 * пуловое (непознанное, невостребованное).
 *
 * Выводится из природы счёта: клиентские деньги плюс тип «обязательство». Это
 * и есть исправление дефекта — прежде здесь стоял перечень из трёх имён, и
 * `unclaimed:liability` в него не входил, поэтому отмывка через него не
 * считалась движением обязательства вообще.
 */
export function isClientObligationAccount(account: Account): boolean {
  const nature = ACCOUNT_NATURE[account.kind];
  return nature.funds === 'client' && nature.type === 'liability';
}

/** Откуда у счёта берётся файл. `null` — счёт не клиентских средств. */
export function clientFundsFile(account: Account): FundsFileScope | null {
  const nature = ACCOUNT_NATURE[account.kind];
  return nature.funds === 'client' ? nature.file : null;
}

/** Направление пула. `null` — счёт пулом не является. */
export function poolDirection(account: Account): PoolDirection | null {
  const nature = ACCOUNT_NATURE[account.kind];
  return nature.funds === 'client' && nature.file === 'pooled' ? nature.pool : null;
}

/** Запертая под конкретный транш часть счёта клиента. */
export function isClientLockedAccount(account: Account): boolean {
  return account.kind === 'client_locked';
}

/**
 * Владелец обязательства. `null` у пуловых счетов — это не пробел, а их
 * определение: клиента у непознанного поступления ещё нет (FUNCTIONAL.md §3.3,
 * шаг 1), у невостребованного его уже нет.
 *
 * Перечня видов счетов здесь тоже больше нет: владелец есть ровно там, где он
 * лежит в значении, а `AssertOwnerInCodeCarriesOwner` держит соответствие между
 * этим и объявленной природой счёта.
 */
export function clientAccountOwner(account: Account): ClientKey | null {
  return 'clientKey' in account ? account.clientKey : null;
}

export function isPlatformIncomeAccount(account: Account): boolean {
  return accountType(account) === 'income';
}

/**
 * Идентификатор, из которого собирается код счёта. Экспортируется, потому что
 * то же ограничение обязано действовать на значениях, которые кодом счёта не
 * являются, но с ним сверяются, — например на объявлении расчёта
 * (`TrancheSettlement`, `entry.ts`): сравнение по коду счёта работает только
 * тогда, когда обе стороны сравнения собраны по одним и тем же правилам.
 */
export function assertAccountIdentifier(value: string, field: string): string {
  // Отсутствующее значение — тоже негодный идентификатор, и отвечать на него
  // обязана эта функция, а не рантайм. Типы здесь не защита: журнал приезжает
  // из базы и из сериализации, где `undefined` на месте `dealId` — обычное
  // дело, а `value.length` на нём давал `TypeError` без кода, без поля и без
  // ключа локализации, то есть ошибку, которую нечем показать и нечем разобрать.
  if (typeof value !== 'string') {
    throw new LedgerError(LedgerErrorCode.accountInvalidIdentifier, {
      field,
      type: value === null ? 'null' : typeof value,
    });
  }
  // Двоеточие — разделитель кода счёта, вертикальная черта — разделитель
  // внутренних ключей источника средств (`entry.ts`). Идентификатор с любым из
  // них делает два разных счёта неотличимыми в сверке.
  if (value.length === 0 || value.includes(':') || value.includes('|')) {
    throw new LedgerError(LedgerErrorCode.accountInvalidIdentifier, { field, value });
  }
  return value;
}

export function accountCode(account: Account): string {
  switch (account.kind) {
    case 'bank_nominal':
      return `bank:nominal:${account.currency.toLowerCase()}`;
    case 'bank_operating':
      return `bank:operating:${account.currency.toLowerCase()}`;
    // Сегменты `free` и `tranche` фиксированные, а не позиционные: без них
    // сделка с идентификатором `free` давала бы код чужого счёта.
    case 'client_free':
      return `client:${assertAccountIdentifier(account.clientKey, 'clientKey')}:free`;
    case 'client_locked':
      return `client:${assertAccountIdentifier(account.clientKey, 'clientKey')}:tranche:${assertAccountIdentifier(
        account.dealId,
        'dealId',
      )}:${assertAccountIdentifier(account.trancheId, 'trancheId')}`;
    case 'suspense_unidentified':
      return 'suspense:unidentified';
    case 'fee_income':
      return 'fee:income';
    case 'fx_income':
      return 'fx:income';
    case 'service_income':
      return 'service:income';
    case 'psp_fee_expense':
      return 'psp:fee:expense';
    case 'oracle_cost_expense':
      return 'oracle:cost:expense';
    case 'shortfall_expense':
      return 'shortfall:expense';
    case 'unclaimed_liability':
      return 'unclaimed:liability';
    case 'transit_writeoff':
      return 'transit:writeoff';
    case 'fx_settlement':
      return `fx:settlement:${assertAccountIdentifier(account.clientKey, 'clientKey')}:${assertAccountIdentifier(
        account.conversionId,
        'conversionId',
      )}`;
    case 'fee_receivable':
      return 'fee:receivable';
    case 'transit_fee':
      return 'transit:fee';
    case 'fx_accounting_diff':
      return 'fx:accounting:diff';
  }
}

export function accountsEqual(left: Account, right: Account): boolean {
  return accountCode(left) === accountCode(right);
}

export const bankNominal = (currency: CurrencyCode): Account => ({ kind: 'bank_nominal', currency });
export const bankOperating = (currency: CurrencyCode): Account => ({
  kind: 'bank_operating',
  currency,
});
export const clientFreeAccount = (owner: ClientKey): Account => ({
  kind: 'client_free',
  clientKey: owner,
});
export const clientLockedAccount = (
  owner: ClientKey,
  dealId: string,
  trancheId: string,
): Account => ({
  kind: 'client_locked',
  clientKey: owner,
  dealId,
  trancheId,
});
export const shortfallExpense: Account = Object.freeze({ kind: 'shortfall_expense' });
export const unclaimedLiability: Account = Object.freeze({ kind: 'unclaimed_liability' });
export const transitWriteoff: Account = Object.freeze({ kind: 'transit_writeoff' });
/**
 * Счёт расчётов с валютным контрагентом **по одной конверсии одного клиента**.
 *
 * Оба параметра обязательны и оба входят в код: пула на все обмены больше нет,
 * и общего счёта на одинаково названные обмены разных клиентов — тоже (см.
 * объявление вида счёта выше).
 */
export const fxSettlement = (owner: ClientKey, conversionId: string): Account =>
  Object.freeze({
    kind: 'fx_settlement',
    clientKey: owner,
    conversionId: assertAccountIdentifier(conversionId, 'conversionId'),
  });
export const feeReceivable: Account = Object.freeze({ kind: 'fee_receivable' });
export const transitFee: Account = Object.freeze({ kind: 'transit_fee' });
export const fxAccountingDiff: Account = Object.freeze({ kind: 'fx_accounting_diff' });
