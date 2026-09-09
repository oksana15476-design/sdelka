import {
  type SeedScenario,
  type SeededScenario,
  type WriteOutcome,
  SEED_SCENARIOS,
  seedChainId,
  seedWorlds,
} from '@sdelka/app';
import type { PoolClient } from '../pool.ts';
import { APP_ROLE } from '../roles.ts';
import { translating } from '../store/errors.ts';
import { pgWorldTransaction } from '../store/pg-store.ts';
import type { WorldStore, WorldTransaction } from '../store/port.ts';
import { SeedError, SeedErrorCode } from './errors.ts';
import { assertSeedable } from './guard.ts';
import { type SeedVerification, verifySeed } from './verify.ts';

/**
 * Засев базы: ворота, прогон сценариев боевым путём, проверка после себя.
 *
 * **Границы транзакций — две, и обе не случайны.**
 *
 * 1. *Шаг мира* — точка сохранения. Свойство, ради которого у шага вообще есть
 *    граница, сохраняется полностью: проводки, состояние и запись журнала
 *    аудита ложатся вместе или не ложатся вовсе.
 * 2. *Сценарий* — точка сохранения вокруг всех его шагов. Это и есть
 *    идемпотентность на случай обрыва: сценарий либо в базе целиком, либо его
 *    там нет, и повтор начинает с чистого места. Без этой границы оборванный
 *    прогон оставлял бы сделку на полпути, а повтор встречал бы конфликт
 *    хранилища — шаг мира идёт «из состояния в состояние» и дописывать
 *    посередине не умеет.
 *
 * Внешнюю границу держит **вызывающий**: команда открывает транзакцию и
 * фиксирует её, интеграционный тест — открывает и откатывает. Один и тот же
 * код проходит оба пути, и тест проверяет ровно то, что делает команда.
 *
 * ⚠ **`SET CONSTRAINTS ALL IMMEDIATE` — не украшение.** Триггеры
 * `assert_entry_balanced` и `assert_entry_has_postings` отложены до `COMMIT`, а
 * `RELEASE SAVEPOINT` их не запускает: без этой строки шаг с несбалансированной
 * записью прошёл бы «успешно», а отказ приехал бы в конце и неизвестно от кого.
 */

export interface SeedRunOptions {
  /** Что сеять. По умолчанию — весь каталог `@sdelka/app`. */
  readonly scenarios?: readonly SeedScenario[];
  /**
   * Роль, под которой идут шаги. Умолчание — роль приложения: засев, идущий от
   * владельца схемы, обходил бы гранты, на которых стоит инвариант 21 (журнал
   * аудита не редактируется), и проверял бы не то, что работает на проде.
   */
  readonly role?: string;
}

export interface SeedRunReport {
  readonly seeded: readonly SeededScenario[];
  /** Сценарии, которые уже лежали в базе тем же самым: повтор ничего не создал. */
  readonly repeated: readonly string[];
  readonly diverged: readonly { readonly id: string; readonly found: string; readonly expected: string }[];
  readonly outcome: WriteOutcome;
  readonly verification: SeedVerification;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]*$/u;

/**
 * Хранилище шага на точках сохранения.
 *
 * Роль ставится `SET LOCAL ROLE` — на время внешней транзакции, как в
 * `pgWorldStore`; снимает её `seedDatabase` после каждого сценария, чтобы
 * ворота и проверка шли от той же роли, от которой их зовут.
 */
function savepointStore(client: PoolClient, role: string, next: () => string): WorldStore {
  return {
    async transact<T>(body: (tx: WorldTransaction) => Promise<T>): Promise<T> {
      const name = next();
      await client.query(`SAVEPOINT ${name}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      try {
        const result = await body(pgWorldTransaction(client));
        await translating(async () => {
          await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        });
        await client.query('SET CONSTRAINTS ALL DEFERRED');
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
        await client.query('SET CONSTRAINTS ALL DEFERRED').catch(() => undefined);
        throw error;
      }
    },
  };
}

async function inSavepoint<T>(client: PoolClient, name: string, body: () => Promise<T>): Promise<T> {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await body();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
    throw error;
  }
}

/**
 * Засев на **уже открытой** транзакции.
 *
 * Клиент приходит снаружи вместе со своей внешней границей: команда её
 * фиксирует, тест откатывает. Ворота стоят первыми — до единой записи.
 */
export async function seedDatabase(
  client: PoolClient,
  options: SeedRunOptions = {},
): Promise<SeedRunReport> {
  const role = options.role ?? APP_ROLE;
  if (!ROLE_NAME.test(role)) {
    throw new SeedError(SeedErrorCode.foreignData, { role });
  }
  const scenarios = options.scenarios ?? SEED_SCENARIOS;

  await assertSeedable(client);

  let counter = 0;
  const next = (): string => {
    counter += 1;
    return `seed_step_${counter}`;
  };
  const store = savepointStore(client, role, next);

  const seeded: SeededScenario[] = [];
  const repeated: string[] = [];
  const diverged: { id: string; found: string; expected: string }[] = [];
  let outcome: WriteOutcome = { written: 0, repeated: 0 };

  for (const [index, item] of scenarios.entries()) {
    const result = await inSavepoint(client, `seed_scenario_${index + 1}`, () =>
      seedWorlds(store, { scenarios: [item] }),
    );
    // Роль снимается на границе сценария: ворота и проверка идут от роли,
    // которой запущена команда, а не от роли приложения.
    await client.query('RESET ROLE');
    seeded.push(...result.seeded);
    repeated.push(...result.repeated);
    diverged.push(...result.diverged);
    outcome = {
      written: outcome.written + result.outcome.written,
      repeated: outcome.repeated + result.outcome.repeated,
    };
  }

  const verification = await verifySeed(
    client,
    scenarios.map((item) => seedChainId(item.id)),
  );

  return {
    seeded: Object.freeze(seeded),
    repeated: Object.freeze(repeated),
    diverged: Object.freeze(diverged),
    outcome,
    verification,
  };
}

/**
 * Отказ по итогам засева.
 *
 * Расхождение сценария и находка проверки — **отказ**, а не строка в отчёте:
 * засев, отчитавшийся успехом на непроверенной базе, — это ровно та ложь, ради
 * которой всё остальное и написано.
 */
export function assertSeedClean(report: SeedRunReport): void {
  if (report.diverged.length > 0) {
    throw new SeedError(SeedErrorCode.diverged, {
      scenarios: report.diverged
        .map((item) => `${item.id}:found=${item.found}:expected=${item.expected}`)
        .join(','),
    });
  }
  if (report.verification.findings.length > 0) {
    throw new SeedError(SeedErrorCode.verificationFailed, {
      findings: report.verification.findings.map((item) => item.code).join(','),
    });
  }
}
