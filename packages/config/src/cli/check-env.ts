import { assertRegistryConsistent, findEnvVariable } from '../registry.ts';
import { checkEnvironment, checkNamedEnvironment, describeEnvironmentCheck } from '../startup.ts';

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

/**
 * Имена в аргументах сужают проверку до того, что процесс ДЕЙСТВИТЕЛЬНО читает.
 *
 * Без сужения у ступени наката миграций были бы обязательными переменные входа
 * в приложение: они лежат в области `app`, а накат — тоже процесс приложения.
 * Ступень при этом ни одной из них не читает, и требовать их от того, кто
 * накатывает схему, значит заставить выставить туда любое значение — то есть
 * научить команду обходить ворота. Обойдённые ворота хуже отсутствующих: они
 * создают уверенность, которой не соответствуют.
 *
 * Перечень при этом остаётся один: имя, которого нет в реестре, отвергается
 * здесь же, а не молча пропускается.
 */
const requested = process.argv.slice(2).filter((argument) => argument.length > 0);
for (const name of requested) findEnvVariable(name);

const check = requested.length === 0 ? checkEnvironment() : checkNamedEnvironment(requested);
if (!check.ok) {
  process.stderr.write(`${describeEnvironmentCheck(check)}\n`);
  process.exit(1);
}

process.stdout.write(`config.env.ok scope=${check.scope}\n`);
