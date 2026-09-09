import { type AuditChain, type AuditRecord, verifyChain } from '@sdelka/audit';
import type {
  DealApplicationSnapshot,
  DealApplicationStore,
  DealApplicationTransaction,
  IntakeStatusPort,
  WriteOutcome,
} from '../../src/index';

/**
 * Хранилище заявок в памяти — **вторая реализация порта, а не мок**.
 *
 * Ожиданий, проверок вызовов и заданного поведения здесь нет ни одного: это две
 * карты, ведущие себя как таблицы. Тот же приём и тот же довод, что у
 * `auth-store.ts`: состояние живёт **снаружи** хранилища (`ApplicationTables`),
 * поэтому «перезапуск процесса» выражается честно — второе хранилище над теми же
 * таблицами и есть поднявшийся заново процесс.
 *
 * Повторены ровно те правила базы, на которых стоят проверки: номер заявки
 * уникален, снимок сверяется с тем, «из чего уходим», журнал только дополняется,
 * сцепка не рвётся — и **транзакция неделима**: тело, бросившее посередине, не
 * оставляет в таблицах ничего.
 */
export interface ApplicationTables {
  readonly applications: Map<string, DealApplicationSnapshot>;
  readonly chains: Map<string, AuditRecord[]>;
}

export function applicationTables(): ApplicationTables {
  return { applications: new Map(), chains: new Map() };
}

/** Нарушение правила хранилища — отказ, а не тихая перезапись. */
export class StoreViolation extends Error {}

function copyOf(data: ApplicationTables): ApplicationTables {
  return {
    applications: new Map(data.applications),
    chains: new Map([...data.chains].map(([id, records]) => [id, [...records]])),
  };
}

function adopt(target: ApplicationTables, source: ApplicationTables): void {
  target.applications.clear();
  for (const [id, snapshot] of source.applications) target.applications.set(id, snapshot);
  target.chains.clear();
  for (const [id, records] of source.chains) target.chains.set(id, [...records]);
}

function outcome(written: number, repeated: number): WriteOutcome {
  return Object.freeze({ written, repeated });
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  const shape = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? `${item}n` : item));
  return shape(left) === shape(right);
}

export interface StoreQuirks {
  /** Запись в вечный журнал отказывает. Нужна одной проверке — неделимости шага. */
  readonly journalRefuses?: boolean;
  /**
   * Выборка по подавшему отдаёт **всё**, что лежит в таблице.
   *
   * Не «сломанный мок»: это правдоподобно неверная реализация порта — забытое
   * условие в `WHERE`. Нужна затем, чтобы проверить, что чужая заявка не выйдет
   * наружу даже так.
   */
  readonly listingIgnoresApplicant?: boolean;
}

function transactionOf(data: ApplicationTables, quirks: StoreQuirks): DealApplicationTransaction {
  return {
    loadApplication: (applicationId: string): Promise<DealApplicationSnapshot | null> =>
      Promise.resolve(data.applications.get(applicationId) ?? null),

    saveApplication: (
      snapshot: DealApplicationSnapshot,
      previous: DealApplicationSnapshot | null,
    ): Promise<WriteOutcome> => {
      const stored = data.applications.get(snapshot.applicationId) ?? null;
      if (stored !== null && sameSnapshot(stored, snapshot)) {
        // Тот же снимок повторно — это повтор, а не вторая строка.
        return Promise.resolve(outcome(0, 1));
      }
      if (!sameSnapshot(stored, previous)) {
        // «Из чего уходим» не совпало с тем, что лежит: в базе это конфликт
        // версии, а не перезапись чужого состояния.
        throw new StoreViolation('db.deal_application.conflict');
      }
      data.applications.set(snapshot.applicationId, snapshot);
      return Promise.resolve(outcome(1, 0));
    },

    applicationsOf: (applicant: string): Promise<readonly DealApplicationSnapshot[]> =>
      Promise.resolve(
        [...data.applications.values()].filter(
          (item) => quirks.listingIgnoresApplicant === true || item.applicant === applicant,
        ),
      ),

    unhandledApplications: (limit: number): Promise<readonly DealApplicationSnapshot[]> =>
      Promise.resolve(
        [...data.applications.values()]
          .filter((item) => item.state === 'submitted' || item.state === 'in_review')
          .slice(0, limit),
      ),

    readChain: (chainId: string): Promise<AuditChain> =>
      Promise.resolve(chainOf(data, chainId)),

    appendAudit: (records: readonly AuditRecord[]): Promise<WriteOutcome> => {
      if (quirks.journalRefuses === true) {
        throw new StoreViolation('db.audit.unavailable');
      }
      let written = 0;
      for (const record of records) {
        const chain = data.chains.get(record.chainId) ?? [];
        const previous = chain[chain.length - 1];
        if (chain.some((item) => item.recordId === record.recordId)) {
          throw new StoreViolation('db.audit.record_duplicate');
        }
        if (previous !== undefined && record.prevHash !== previous.recordHash) {
          // Сцепка — то, ради чего журнал существует: запись, не продолжающая
          // предыдущую, в таблицу не ложится.
          throw new StoreViolation('db.audit.chain_broken');
        }
        chain.push(record);
        data.chains.set(record.chainId, chain);
        written += 1;
      }
      return Promise.resolve(outcome(written, 0));
    },
  };
}

/**
 * Хранилище над таблицами.
 *
 * Транзакция настоящая по единственному свойству, которое проверяется:
 * **неделимости**. Тело работает над копией таблиц, и копия переносится в
 * таблицы только если тело дошло до конца. Отказ на второй записи не оставляет
 * первую — а именно это и означает «снимок и журнал одной транзакцией».
 */
export function memoryApplicationStore(
  data: ApplicationTables,
  quirks: StoreQuirks = {},
): DealApplicationStore {
  return {
    transact: async <T>(body: (tx: DealApplicationTransaction) => Promise<T>): Promise<T> => {
      const staged = copyOf(data);
      const result = await body(transactionOf(staged, quirks));
      adopt(data, staged);
      return result;
    },
  };
}

/** Приём открыт или остановлен — вторая реализация порта, значение, а не мок. */
export function intakeStatus(open: boolean): IntakeStatusPort {
  return { isOpen: (): Promise<boolean> => Promise.resolve(open) };
}

/** Цепочка из таблиц как значение: сцепку проверяет настоящая `verifyChain`. */
export function chainOf(data: ApplicationTables, chainId: string): AuditChain {
  return Object.freeze({
    chainId,
    records: Object.freeze([...(data.chains.get(chainId) ?? [])]),
  });
}

export function chainIntact(data: ApplicationTables, chainId: string): boolean {
  return verifyChain(chainOf(data, chainId)).intact;
}
