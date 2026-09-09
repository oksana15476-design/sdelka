import { assertRegistryConsistent } from '../registry.ts';
import { checkEnvironment, describeEnvironmentCheck } from '../startup.ts';

/**
 * `pnpm env:check` — ворота старта.
 *
 * Ставится перед запуском процесса (`pnpm env:check && pnpm start`) и в
 * разворачивающий скрипт. Не хватает обязательной переменной — код возврата 1 и
 * список имён в `stderr`; процесс приложения после этого не запускается.
 *
 * В корневой `pnpm test` эта команда **не входит и входить не должна**: рабочее
 * дерево разработчика законно живёт без строки подключения (офлайн-наборы её не
 * требуют), и красный `test` у всех, кто не поднял базу, кончится тем, что
 * проверку отключат.
 */
assertRegistryConsistent();

const check = checkEnvironment();
if (!check.ok) {
  process.stderr.write(`${describeEnvironmentCheck(check)}\n`);
  process.exit(1);
}

process.stdout.write(`config.env.ok scope=${check.scope}\n`);
