import { type AuditChain, type AuditRecord, verifyChain } from '@sdelka/audit';
import type {
  DealSnapshot,
  PayoutSnapshot,
  TrancheSnapshot,
  WorldStore,
  WorldTransaction,
  WriteOutcome,
} from '@sdelka/app';
import { type Journal, type JournalEntry, appendEntry, emptyJournal } from '@sdelka/ledger';

/**
 * Хранилище мира в памяти — **реализация того же порта**, что и Postgres, а не
 * заглушка под него.
 *
 * **Почему оно вообще существует и почему это не мок.** `CLAUDE.md` запрещает
 * ровно одно: «если для теста нужен мок платёжного провайдера — тест написан
 * неверно». Провайдер — источник внешних фактов, и подменять его значит
 * подменять реальность. Хранилище фактов не производит: оно только помнит то,
 * что ему дали. У этой реализации нет ни ожиданий, ни проверки вызовов, ни
 * поведения — есть карты и правила записи, дословно повторяющие правила
 * `packages/db/src/store/**`:
 *
 * - повтор и конфликт **различимы**: совпало содержимое — `repeated`, не
 *   совпало — отказ с именем, а не «последний записавший выиграл»;
 * - шаг ложится **целиком или не ложится вовсе**: тело транзакции работает над
 *   копией, и копия становится состоянием только при успехе;
 * - правила формы записи здесь **не повторяются**. Что база удержать может, а
 *   чего нет, решает схема и сверяющая её с типами учёта карта
 *   (`packages/db/src/store/entry-shape.ts`); зеркало этих правил здесь
 *   разошлось бы с оригиналом молча — так и случилось бы в этом батче, где
 *   колонки под объявления записи появились по соседству, пока шла работа;
 * - журнал на чтении **пересобирается** `appendEntry`, а не отдаётся как
 *   лежит: прочитанный журнал заново проходит правила учёта, которым нужна
 *   история.
 *
 * ⚠ **Чего это не доказывает.** Что то же самое проходит в Postgres. Схему
 * сторожат интеграционные тесты `packages/db` (`pnpm --filter @sdelka/db
 * test:int`, нужен кластер), а форму порта — проверка типов
 * (`store-port.test.ts`). Здесь проверяется третье и отдельное: что **шаг мира**
 * умеет в хранилище писать и что мир из хранилища поднимается. Прогон сквозного
 * сценария против настоящего кластера — отдельная работа, и она названа в
 * отчёте, а не выдана за сделанную.
 */

/**
 * Ключи отказов повторяют `DbErrorCode` дословно.
 *
 * Второй ключ для того же нарушения — это два разных ответа на один вопрос
 * (`packages/db/src/errors.ts`). Пакет `@sdelka/db` сюда не подключён (ребро
 * `e2e → db` тянуло бы `pg` в сквозные сценарии, которым он не нужен), поэтому
 * строки повторены здесь; совпадение сторожит `store-port.test.ts`.
 */
export const STORE_ERROR = Object.freeze({
  conflict: 'db.step.conflict',
  stateConflict: 'db.step.state_conflict',
} as const);

export class MemoryStoreError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: string, details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'MemoryStoreError';
    this.code = code;
    this.details = details;
  }
}

/** Сравнение доменных значений, а не строк таблицы: см. `sameEntry` в `packages/db`. */
function same(left: unknown, right: unknown): boolean {
  const shape = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item));
  return shape(left) === shape(right);
}

interface Rows {
  readonly entries: Map<string, JournalEntry>;
  readonly records: Map<string, AuditRecord>;
  readonly deals: Map<string, DealSnapshot>;
  readonly tranches: Map<string, TrancheSnapshot>;
  readonly payouts: Map<string, PayoutSnapshot>;
}

function emptyRows(): Rows {
  return {
    entries: new Map(),
    records: new Map(),
    deals: new Map(),
    tranches: new Map(),
    payouts: new Map(),
  };
}

function copy(rows: Rows): Rows {
  return {
    entries: new Map(rows.entries),
    records: new Map(rows.records),
    deals: new Map(rows.deals),
    tranches: new Map(rows.tranches),
    payouts: new Map(rows.payouts),
  };
}

const trancheKey = (dealId: string, trancheId: string): string => `${dealId}|${trancheId}`;

class MemoryTransaction implements WorldTransaction {
  readonly #rows: Rows;

  constructor(rows: Rows) {
    this.#rows = rows;
  }

  async appendJournal(entries: readonly JournalEntry[]): Promise<WriteOutcome> {
    let written = 0;
    let repeated = 0;
    for (const entry of entries) {
      const existing = this.#rows.entries.get(entry.id);
      if (existing !== undefined) {
        if (!same(existing, entry)) {
          throw new MemoryStoreError(STORE_ERROR.conflict, {
            relation: 'ledger_entry',
            id: entry.id,
          });
        }
        repeated += 1;
        continue;
      }
      this.#rows.entries.set(entry.id, entry);
      written += 1;
    }
    return { written, repeated };
  }

  async readJournal(): Promise<Journal> {
    let journal = emptyJournal;
    for (const entry of this.#rows.entries.values()) {
      journal = appendEntry(journal, entry);
    }
    return journal;
  }

  async appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome> {
    let written = 0;
    let repeated = 0;
    for (const record of records) {
      const key = `${record.chainId}|${record.seq}`;
      const existing = this.#rows.records.get(key);
      if (existing !== undefined) {
        // Повтор — это когда место занято **той же** записью, и хеш покрывает
        // весь конверт. Другой хеш на том же месте — подмена звена.
        if (existing.recordHash !== record.recordHash) {
          throw new MemoryStoreError(STORE_ERROR.conflict, {
            relation: 'audit_record',
            chainId: record.chainId,
            seq: String(record.seq),
          });
        }
        repeated += 1;
        continue;
      }
      this.#rows.records.set(key, record);
      written += 1;
    }
    return { written, repeated };
  }

  async readChain(chainId: string): Promise<AuditChain> {
    const records = [...this.#rows.records.values()]
      .filter((record) => record.chainId === chainId)
      .sort((left, right) => left.seq - right.seq);
    const chain: AuditChain = Object.freeze({ chainId, records: Object.freeze(records) });
    const integrity = verifyChain(chain);
    if (!integrity.intact) {
      throw new MemoryStoreError(`db.audit.${integrity.firstBreak.kind}`, { chainId });
    }
    return chain;
  }

  async saveDeal(snapshot: DealSnapshot): Promise<WriteOutcome> {
    const existing = this.#rows.deals.get(snapshot.dealId);
    if (existing === undefined) {
      // `deal_parties_distinct`: одна личность на обеих сторонах — отказ.
      if (snapshot.buyer.partyId === snapshot.seller.partyId) {
        throw new MemoryStoreError(STORE_ERROR.conflict, {
          relation: 'deal',
          id: snapshot.dealId,
          constraint: 'deal_parties_distinct',
        });
      }
      this.#rows.deals.set(snapshot.dealId, snapshot);
      return { written: 1, repeated: 0 };
    }
    if (same(existing, snapshot)) return { written: 0, repeated: 1 };
    // Стороны сделки не меняются, статус меняется.
    if (
      existing.buyer.partyId !== snapshot.buyer.partyId ||
      existing.seller.partyId !== snapshot.seller.partyId
    ) {
      throw new MemoryStoreError(STORE_ERROR.conflict, { relation: 'deal', id: snapshot.dealId });
    }
    this.#rows.deals.set(snapshot.dealId, snapshot);
    return { written: 1, repeated: 0 };
  }

  async loadDeal(dealId: string): Promise<DealSnapshot | null> {
    return this.#rows.deals.get(dealId) ?? null;
  }

  async saveTranche(
    snapshot: TrancheSnapshot,
    previous: TrancheSnapshot | null,
  ): Promise<WriteOutcome> {
    const key = trancheKey(snapshot.dealId, snapshot.trancheId);
    const current = this.#rows.tranches.get(key) ?? null;
    // Внешний ключ на сделку: транша без сделки не бывает.
    if (!this.#rows.deals.has(snapshot.dealId)) {
      throw new MemoryStoreError(STORE_ERROR.conflict, {
        relation: 'tranche',
        id: key,
        constraint: 'tranche_deal_id_fkey',
      });
    }
    if (previous === null ? current === null : current !== null && same(current, previous)) {
      this.#rows.tranches.set(key, snapshot);
      return { written: 1, repeated: 0 };
    }
    // Шаг уже применён — повтор; лежит чужое состояние — отказ с именем.
    if (current !== null && same(current, snapshot)) return { written: 0, repeated: 1 };
    throw new MemoryStoreError(STORE_ERROR.stateConflict, {
      relation: 'tranche',
      id: key,
      expected: snapshot.state.status,
      actual: current?.state.status ?? '',
    });
  }

  async loadTranche(dealId: string, trancheId: string): Promise<TrancheSnapshot | null> {
    return this.#rows.tranches.get(trancheKey(dealId, trancheId)) ?? null;
  }

  async savePayout(
    snapshot: PayoutSnapshot,
    previous: PayoutSnapshot | null,
  ): Promise<WriteOutcome> {
    const current = this.#rows.payouts.get(snapshot.payoutId) ?? null;
    if (previous === null ? current === null : current !== null && same(current, previous)) {
      // Инвариант 9: не более одной выплаты по траншу в активных статусах.
      // Частичный уникальный индекс `payout_one_active_per_tranche`.
      const active = ['created', 'submitted', 'unknown'];
      if (active.includes(snapshot.state.status)) {
        for (const other of this.#rows.payouts.values()) {
          if (other.payoutId === snapshot.payoutId) continue;
          if (
            other.dealId === snapshot.dealId &&
            other.state.trancheId === snapshot.state.trancheId &&
            active.includes(other.state.status)
          ) {
            throw new MemoryStoreError(STORE_ERROR.conflict, {
              relation: 'payout',
              id: snapshot.payoutId,
              constraint: 'payout_one_active_per_tranche',
            });
          }
        }
      }
      // `payout_response_only_when_answered` (0018).
      if (
        snapshot.providerReference !== null &&
        snapshot.state.status !== 'settled' &&
        snapshot.state.status !== 'rejected'
      ) {
        throw new MemoryStoreError(STORE_ERROR.conflict, {
          relation: 'payout',
          id: snapshot.payoutId,
          constraint: 'payout_response_only_when_answered',
        });
      }
      this.#rows.payouts.set(snapshot.payoutId, snapshot);
      return { written: 1, repeated: 0 };
    }
    if (current !== null && same(current, snapshot)) return { written: 0, repeated: 1 };
    throw new MemoryStoreError(STORE_ERROR.stateConflict, {
      relation: 'payout',
      id: snapshot.payoutId,
      expected: snapshot.state.status,
      actual: current?.state.status ?? '',
    });
  }

  async loadPayouts(dealId: string, trancheId: string): Promise<readonly PayoutSnapshot[]> {
    return Object.freeze(
      [...this.#rows.payouts.values()].filter(
        (payout) => payout.dealId === dealId && payout.state.trancheId === trancheId,
      ),
    );
  }
}

export interface MemoryStore extends WorldStore {
  /** Сколько транзакций доехало до конца. Видно тесту, а не выводится по следам. */
  readonly committed: number;
  /** Заставить следующую запись отказать — как отказывает база. */
  failOnce(code: string): void;
}

/**
 * Хранилище с явной границей транзакции.
 *
 * `failOnce` существует ради одного вопроса, который иначе не задать: что
 * происходит с шагом, когда база отказала. Это не «мок ошибки»: отказ ставится
 * снаружи и ничего не изображает — он проверяет **наш** порядок действий, а не
 * поведение Postgres.
 */
export function memoryWorldStore(): MemoryStore {
  let rows = emptyRows();
  let committed = 0;
  let failure: string | null = null;
  return {
    get committed() {
      return committed;
    },
    failOnce(code: string) {
      failure = code;
    },
    async transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T> {
      // Работа идёт над копией: шаг ложится целиком либо не ложится вовсе.
      const draft = copy(rows);
      const result = await body(new MemoryTransaction(draft));
      if (failure !== null) {
        const code = failure;
        failure = null;
        throw new MemoryStoreError(code, { relation: 'commit' });
      }
      rows = draft;
      committed += 1;
      return result;
    },
  };
}
