import type { AuditChain, AuditRecord } from '@sdelka/audit';
import type { Journal, JournalEntry } from '@sdelka/ledger';
import { DbError, DbErrorCode } from '../errors.ts';
import type { Pool, PoolClient } from '../pool.ts';
import { APP_ROLE } from '../roles.ts';
import { appendAudit, readChain } from './audit.ts';
import { translating } from './errors.ts';
import { appendJournal, readJournal } from './journal.ts';
import type {
  DealSnapshot,
  PayoutSnapshot,
  TrancheSnapshot,
  WorldStore,
  WorldTransaction,
  WriteOutcome,
} from './port.ts';
import {
  loadDeal,
  loadPayouts,
  loadTranche,
  saveDeal,
  savePayout,
  saveTranche,
} from './state.ts';

/**
 * Реализация порта на Postgres.
 *
 * Здесь нет ни одного правила: правила живут в трёх местах — в домене и учёте
 * (TypeScript), в схеме (ограничения, триггеры, гранты) и в переводе отказов
 * (`errors.ts`). Этот файл только связывает их и держит транзакцию.
 */

/**
 * Транзакция над **уже открытым** соединением.
 *
 * Отдельно от `pgWorldStore` намеренно: границу транзакции держит тот, кто её
 * открыл. Это нужно двум разным вызывающим — набору интеграционных тестов,
 * который заворачивает всё в откат, и будущему коду, которому шаг мира надо
 * сложить в уже идущую транзакцию. Дверью мимо правил это не является:
 * `PgTransaction` не умеет ничего сверх того, что умеет порт.
 */
export function pgWorldTransaction(client: PoolClient): WorldTransaction {
  return new PgTransaction(client);
}

class PgTransaction implements WorldTransaction {
  readonly #client: PoolClient;

  constructor(client: PoolClient) {
    this.#client = client;
  }

  appendJournal(entries: readonly JournalEntry[]): Promise<WriteOutcome> {
    return appendJournal(this.#client, entries);
  }

  readJournal(): Promise<Journal> {
    return readJournal(this.#client);
  }

  appendAudit(records: readonly AuditRecord[]): Promise<WriteOutcome> {
    return appendAudit(this.#client, records);
  }

  readChain(chainId: string): Promise<AuditChain> {
    return readChain(this.#client, chainId);
  }

  saveDeal(snapshot: DealSnapshot): Promise<WriteOutcome> {
    return saveDeal(this.#client, snapshot);
  }

  loadDeal(dealId: string): Promise<DealSnapshot | null> {
    return loadDeal(this.#client, dealId);
  }

  saveTranche(snapshot: TrancheSnapshot, previous: TrancheSnapshot | null): Promise<WriteOutcome> {
    return saveTranche(this.#client, snapshot, previous);
  }

  loadTranche(dealId: string, trancheId: string): Promise<TrancheSnapshot | null> {
    return loadTranche(this.#client, dealId, trancheId);
  }

  savePayout(snapshot: PayoutSnapshot, previous: PayoutSnapshot | null): Promise<WriteOutcome> {
    return savePayout(this.#client, snapshot, previous);
  }

  loadPayouts(dealId: string, trancheId: string): Promise<readonly PayoutSnapshot[]> {
    return loadPayouts(this.#client, dealId, trancheId);
  }
}

export interface PgStoreOptions {
  /**
   * Роль, под которой идёт шаг. Умолчание — роль приложения, и это не
   * украшение: инвариант 21 (`FUNCTIONAL.md`, `CORE.md` Ф11) требует, чтобы
   * прав на изменение и удаление журнала аудита у приложения **не было**, и
   * держится он грантами. Гранты действуют на роль; шаг, выполненный от имени
   * владельца схемы, обходит их целиком, и инвариант перестаёт существовать,
   * не оставив следа.
   *
   * `SET LOCAL ROLE` — на время транзакции, поэтому соединение возвращается в
   * пул тем же, каким взято.
   */
  readonly role?: string;
}

/**
 * Хранилище поверх пула.
 *
 * Транзакция открывается на **каждый** шаг, а не на весь процесс: шаг мира либо
 * ложится целиком (журнал, состояние и журнал аудита вместе), либо не ложится
 * вовсе. Отложенные триггеры схемы (`assert_entry_balanced`,
 * `assert_entry_has_postings`) срабатывают на `COMMIT`, поэтому «запись
 * несбалансирована» приходит из `commit`, а не из `INSERT`, — и приходит она
 * переведённой, потому что `COMMIT` тоже завёрнут в перевод.
 */
export function pgWorldStore(pool: Pool, options: PgStoreOptions = {}): WorldStore {
  const role = assertRoleName(options.role ?? APP_ROLE);
  return {
    async transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        const result = await body(new PgTransaction(client));
        // `COMMIT` тоже под переводом: отложенные триггеры схемы срабатывают
        // именно здесь, и их отказ обязан приехать нашим ключом.
        await translating(async () => {
          await client.query('COMMIT');
        });
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Имя роли — идентификатор, и в SQL он подставляется текстом: `SET LOCAL ROLE`
 * параметров не принимает. Поэтому алфавит проверяется явно, а не «мы же знаем,
 * что там константа»: строка из настройки однажды придёт из окружения.
 */
const ROLE_NAME = /^[a-z_][a-z0-9_]*$/u;

function assertRoleName(role: string): string {
  if (!ROLE_NAME.test(role)) {
    throw new DbError(DbErrorCode.roleMissing, { role });
  }
  return role;
}
