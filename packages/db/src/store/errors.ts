import { AuditError, AuditErrorCode } from '@sdelka/audit';
import { DomainError, RejectionCode } from '@sdelka/domain';
import { InvariantCode, LedgerError, LedgerErrorCode } from '@sdelka/ledger';
import { DbError, DbErrorCode } from '../errors.ts';

/**
 * Перевод отказа базы в ошибку с **тем же ключом**, что у соответствующей
 * проверки кода.
 *
 * Без этого слоя инварианты базы срабатывают, но не существуют для приложения:
 * наверх приезжает `error: DatabaseError` с текстом от драйвера, и дежурный
 * читает разные сообщения об одном и том же в зависимости от того, кто поймал
 * нарушение — код или база. Ровно об этом предупреждает `src/errors.ts`:
 * «второй ключ для того же нарушения» — это два разных ответа на один вопрос.
 *
 * Ключ берётся из двух мест, и оба — не текст сообщения драйвера:
 *
 * 1. **`RAISE EXCEPTION '<ключ>'`.** Наши триггеры поднимают технический ключ
 *    сообщением. Сверку «каждый поднимаемый ключ известен коду» держит тест
 *    дрейфа (`test/codes.test.ts`), поэтому здесь достаточно разобрать префикс:
 *    `ledger.` — учёт, `audit.` — журнал, `db.` — правило, которого в коде нет
 *    вовсе. Перечислять ключи поимённо второй раз значило бы завести третий
 *    список, который разойдётся с первыми двумя.
 * 2. **Имя ограничения** (`CHECK`, `UNIQUE`, частичный индекс). У них
 *    сообщения нет — есть `constraint` в ошибке драйвера, и его надо назвать
 *    поимённо: это единственное место, где связь «ограничение схемы ↔ правило
 *    кода» вообще записана.
 *
 * **Чего перевод не делает.** Он не превращает незнакомую ошибку во что-нибудь
 * знакомое. Неизвестная ошибка возвращается как есть — тот же довод, по
 * которому `isDatabaseUnreachable` отказывается угадывать: подстановка
 * похожего ключа сделала бы отчёт дежурного ложным ровно в тот момент, когда
 * он нужен.
 */

/** Ошибка драйвера в том виде, в каком её отдаёт `pg`. Поля необязательны. */
interface DriverError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly detail?: unknown;
}

function field(error: unknown, name: keyof DriverError): string | null {
  if (typeof error !== 'object' || error === null || !(name in error)) return null;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Все коды учёта: и ключи отказов конструктора (`LedgerErrorCode`), и ключи
 * инвариантов (`InvariantCode`). Оба перечня начинаются на `ledger.` и оба
 * поднимаются миграциями, поэтому по префиксу они неразличимы — и различать их
 * незачем: класс ошибки у них один.
 */
const LEDGER_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(LedgerErrorCode),
  ...Object.values(InvariantCode),
]);

const AUDIT_CODES: ReadonlySet<string> = new Set<string>(Object.values(AuditErrorCode));

const DB_CODES: ReadonlySet<string> = new Set<string>(Object.values(DbErrorCode));

/**
 * Имена ограничений схемы и правила кода, которые они зеркалят.
 *
 * Список закрытый и короткий намеренно: сюда попадает только то, что вообще
 * достижимо через порт хранилища. Ограничение, которого порт достичь не может
 * (форма состояния транша собирается из значения `TrancheState`, а его нельзя
 * построить неверным), в переводе не нуждается — и придумывать ему ключ значило
 * бы завести имя правилу, которого никто не нарушал.
 */
type Translator = (detail: string) => Error;

const ledger = (code: LedgerErrorCode): Translator => (detail) =>
  new LedgerError(code, detail === '' ? {} : { detail });

const CONSTRAINT_RULES: Readonly<Record<string, Translator>> = Object.freeze({
  /**
   * Одна личность на обеих сторонах одной сделки — отказ, а не предупреждение
   * (`FUNCTIONAL.md` §2.1). Ключ тот же, которым это правило названо в схеме
   * рядом, у `ledger_entry_settles_not_self`, и в `ledger/src/entry.ts`.
   */
  deal_parties_distinct: ledger(LedgerErrorCode.settlementSelfDealing),
  ledger_entry_settles_not_self: ledger(LedgerErrorCode.settlementSelfDealing),
  /** Сумма проводки неположительна: `ledger.posting.non_positive_amount`. */
  ledger_posting_amount_minor_check: ledger(LedgerErrorCode.postingNonPositiveAmount),
  /** Половина объявления расчёта — не объявление. */
  ledger_entry_settles_whole: ledger(LedgerErrorCode.entrySettlementShapeMismatch),
  /** Красная линия №5: расчёт без ссылки на пакет доказательств. */
  ledger_entry_evidence_present: ledger(LedgerErrorCode.entrySettlementShapeMismatch),
  ledger_entry_settles_alphabet: ledger(LedgerErrorCode.accountInvalidIdentifier),
  ledger_posting_client_key_alphabet: ledger(LedgerErrorCode.accountInvalidIdentifier),
  ledger_posting_identifier_alphabet: ledger(LedgerErrorCode.accountInvalidIdentifier),
  ledger_posting_attribution_client_alphabet: ledger(LedgerErrorCode.accountInvalidIdentifier),
  /** Исправление без ссылки и расчёт со ссылкой — одно выражение, два отказа. */
  ledger_entry_correction_reference: ledger(LedgerErrorCode.entryCorrectionWithoutReference),
  ledger_entry_correction_not_self: ledger(LedgerErrorCode.journalCorrectionTargetMissing),
  /** Отнесение проводки — либо клиент, либо сделка с траншем, либо ничего. */
  ledger_posting_attribution_shape: ledger(LedgerErrorCode.postingAttributionMismatch),
  ledger_posting_fee_attributed: ledger(LedgerErrorCode.postingFeeWithoutTrancheAttribution),
  /**
   * Инвариант 9 целиком: не более одной выплаты по траншу в активных статусах.
   * В коде это guard `g_no_active_payout`, то есть отказ автомата с кодом
   * `domain.guard.failed`, — и имя guard'а обязано доехать до дежурного, иначе
   * «отказ автомата» без указания правила не отличим ни от чего.
   */
  payout_one_active_per_tranche: () =>
    new DomainError(RejectionCode.guardFailed, 'g_no_active_payout'),
  withdrawal_one_active_per_party: () =>
    new DomainError(RejectionCode.guardFailed, 'g_no_active_withdrawal'),
  /** Состояние после `pending` без акта получателя (`CORE.md` Ф13). */
  tranche_condition_act_required: () => new DomainError(RejectionCode.conditionActMissing),
  /** `registration_preliminary` помечен **[открыто]** и основанием не является. */
  condition_act_usable_type: () =>
    new DomainError(RejectionCode.releaseConditionRequiresConfirmation),
});

/** Ошибка, у которой имя уже есть: она пришла не от драйвера, а от нас. */
function isNamed(error: unknown): boolean {
  return (
    error instanceof DbError ||
    error instanceof LedgerError ||
    error instanceof AuditError ||
    error instanceof DomainError
  );
}

/**
 * Ключ, поднятый триггером сообщением. `null` — сообщение не является ключом,
 * который знает код: угадывать по тексту драйвера мы не будем.
 */
function raisedKey(error: unknown): string | null {
  const message = field(error, 'message');
  if (message === null) return null;
  return LEDGER_CODES.has(message) || AUDIT_CODES.has(message) || DB_CODES.has(message)
    ? message
    : null;
}

function fromKey(key: string, detail: string): Error {
  const details = detail === '' ? {} : { detail };
  if (LEDGER_CODES.has(key)) {
    // Единственное приведение в файле. `LedgerError` объявлен над
    // `LedgerErrorCode`, а половина ключей учёта в SQL — это `InvariantCode`:
    // два перечня, один класс ошибки. Приведение безопасно ровно потому, что
    // ключ взят из объединения этих двух перечней строкой выше, а не из текста.
    return new LedgerError(key as LedgerErrorCode, details);
  }
  if (AUDIT_CODES.has(key)) {
    return new AuditError(key as AuditErrorCode, details);
  }
  return new DbError(key as DbErrorCode, details);
}

/**
 * Перевод. Возвращает ошибку, которую надо бросить: либо названную нашим
 * ключом, либо исходную — но никогда не выдуманную.
 */
export function translateStorageError(error: unknown): unknown {
  // Уже названная ошибка переводу не подлежит. Без этой строки собственный
  // отказ хранилища (`db.entry.declaration_not_storable`) пересобирался бы
  // заново по своему же сообщению — с тем же кодом, но без подробностей,
  // потому что `detail` у него не поле драйвера, а наше.
  if (isNamed(error)) return error;
  const key = raisedKey(error);
  const detail = field(error, 'detail') ?? '';
  if (key !== null) return fromKey(key, detail);
  const constraint = field(error, 'constraint');
  if (constraint !== null) {
    const rule = CONSTRAINT_RULES[constraint];
    if (rule !== undefined) return rule(detail);
  }
  return error;
}

/** Имена ограничений, у которых перевод есть. Для теста дрейфа. */
export const TRANSLATED_CONSTRAINTS: readonly string[] = Object.freeze(
  Object.keys(CONSTRAINT_RULES),
);

/**
 * Обёртка вокруг запроса: любой отказ базы выходит наружу переведённым.
 *
 * Ставится вокруг **каждого** обращения хранилища, а не выборочно вокруг тех,
 * где нарушение «ожидается»: правило, срабатывающее только там, где его ждали,
 * — это не правило, а тест.
 */
export async function translating<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw translateStorageError(error);
  }
}
