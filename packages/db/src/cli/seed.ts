import { requireDatabaseUrl } from '../env.ts';
import { createPool } from '../pool.ts';
import { SeedError } from '../seed/errors.ts';
import { assertSeedClean, seedDatabase } from '../seed/run.ts';
import { failureLine, reportFailure } from './report.ts';

/**
 * `pnpm --filter @sdelka/db seed` — засев базы сценариями интерфейса.
 *
 * Порядок один: база готова → `pnpm db:migrate` → эта команда. Схема командой
 * не трогается вовсе: шаги идут от роли приложения (`sdelka_app`), то есть
 * ровно с теми правами, с какими работает продукт.
 *
 * **Команда отказывается работать на базе с настоящими данными.** Признак
 * «настоящих» — строка, которую засев не именовал своим началом
 * (`seed/guard.ts`); отказ приходит до единой записи.
 *
 * Коды выхода — контракт для разворачивающего скрипта:
 *
 * - `0` — база засеяна либо уже была засеяна тем же самым. Повтор на засеянной
 *   базе — успех, а не ошибка: команда, падающая на повторе, приучает
 *   разворачивающего игнорировать её код выхода;
 * - `1` — засев остановлен. Транзакция откачена целиком: в базе не осталось ни
 *   одной строки этого прогона. Сюда же попадает несошедшаяся проверка после
 *   засева — журнал, покрытие или цепочка.
 *
 * Отказ печатается **техническим ключом**, а не стеком: в свойствах ошибки
 * драйвера лежит адрес базы и пользователь (красная линия №12).
 */
async function main(): Promise<number> {
  const pool = createPool(requireDatabaseUrl());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await seedDatabase(client);
    // Проверка идёт **до** фиксации: база, не прошедшая её, не остаётся.
    assertSeedClean(report);
    await client.query('COMMIT');
    const coverage = report.verification.coverage
      .map((row) => `${row.currency}:${row.custodyMinor}/${row.obligationsMinor}`)
      .join(',');
    process.stdout.write(
      `db.seed.ok seeded=${report.seeded.map((item) => item.id).join(',') || '-'}` +
        ` repeated=${report.repeated.join(',') || '-'}` +
        ` written=${report.outcome.written} entries=${report.verification.entries}` +
        ` records=${report.verification.records}` +
        ` coverage=${coverage || '-'}\n`,
    );
    return 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

/** Отказ засева печатается тем же способом, что и отказ базы: ключ и подробности. */
function seedFailure(error: unknown, write: (line: string) => void): number {
  if (error instanceof SeedError) {
    const details = Object.entries(error.details)
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => ` ${key}=${value}`)
      .join('');
    write(`${error.code}${details}\n`);
    return 1;
  }
  write(`${failureLine(error)}\n`);
  return 1;
}

process.exitCode = await main().catch((error: unknown) =>
  error instanceof SeedError
    ? seedFailure(error, (line) => process.stderr.write(line))
    : reportFailure(error, (line) => process.stderr.write(line)),
);
