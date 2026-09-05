#!/usr/bin/env node
/**
 * Рабочий процесс мутационного прогона: один живой vitest, много мутаций.
 *
 * ## Зачем не «процесс на мутацию»
 *
 * Первая версия запускала `vitest run` заново на каждую мутацию. Считалось это
 * честно и работало — четыреста мутаций за два с половиной часа, из которых
 * почти всё уходило на разбор одних и тех же исходников заново. Проверка,
 * которую нельзя прогнать дважды за рабочий день, перестаёт быть проверкой:
 * её перестают запускать.
 *
 * Здесь vitest поднимается **один раз**, а мутации прогоняются его же
 * повторными запусками (`rerunFiles`). Разбор модулей переиспользуется, кроме
 * одного — мутируемого: он помечается изменённым, и только он собирается
 * заново.
 *
 * ## Почему процессов несколько и ими управляет надзиратель
 *
 * Мутация числа умеет увести код в вечный цикл (`index -= 1` → `index -= 0`).
 * Синхронный вечный цикл в рабочем потоке не прерывается ни таймаутом теста, ни
 * чем-либо внутри процесса: событийный цикл занят. Единственный способ его
 * прекратить — убить процесс снаружи. Поэтому рабочий процесс отделён от
 * надзирателя (`intake-mutation.mjs`), который его и убивает, засчитывая
 * зацикливание как убитого мутанта — поведение изменилось так, что прогон
 * не дошёл до конца.
 *
 * ## Протокол
 *
 * Из надзирателя приходят строки — по идентификатору мутации в строке, `QUIT`
 * завершает. В надзиратель уходят: `READY`, `BASELINE ok|fail`, `RESULT <id>
 * <вердикт> <примечание>`. Пул тянущий, а не толкающий: следующая мутация
 * выдаётся тому, кто освободился, поэтому медленный процесс не держит очередь.
 */
import { createInterface } from 'node:readline';
import { createVitest } from 'vitest/node';
import { MUTATION_ENV, findMutant, targetFile } from './intake-mutants.mjs';

const CONFIG = 'scripts/mutation.vitest.config.ts';

/** Куда сложила метки конфигурация: `mutation.vitest.config.ts`. */
function appliedMarks() {
  const marks = globalThis.__sdelkaMutationApplied;
  return marks instanceof Set ? marks : new Set();
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

const vitest = await createVitest('test', {
  config: CONFIG,
  watch: false,
  silent: true,
  reporters: [],
});

await vitest.start();
const paths = vitest.state.getFilepaths();
const baselineFailures = vitest.state.getFiles().filter((file) => file.result?.state === 'fail');
if (baselineFailures.length > 0 || paths.length === 0) {
  say(`BASELINE fail ${baselineFailures.length} падений, ${paths.length} наборов`);
  await vitest.close();
  process.exit(1);
}
say('BASELINE ok');

/** Файлы, помеченные изменёнными в прошлый раз: их нужно вернуть к оригиналу. */
let dirty = [];

function invalidate(files) {
  for (const project of vitest.projects) {
    const server = project.vite ?? project.server;
    if (server === undefined) continue;
    for (const file of files) {
      const module = server.moduleGraph.getModuleById(file);
      if (module === undefined || module === null) continue;
      server.moduleGraph.invalidateModule(module, new Set(), Date.now(), true);
    }
  }
}

async function runMutant(id) {
  const mutant = findMutant(id);
  const file = targetFile(mutant);
  process.env[MUTATION_ENV] = id;
  invalidate([...new Set([...dirty, file])]);
  dirty = [file];
  appliedMarks().clear();

  await vitest.rerunFiles(paths, `mutation:${id}`, true);

  const files = vitest.state.getFiles();
  const failed = files.filter((item) => item.result?.state === 'fail').length;
  const applied = appliedMarks().has(id);
  if (!applied) return ['broken', 'подмена не дошла до исходника'];
  if (files.length !== paths.length) return ['broken', 'прогнаны не все наборы'];
  return failed > 0 ? ['killed', ''] : ['survived', ''];
}

const input = createInterface({ input: process.stdin });
say('READY');
for await (const line of input) {
  const id = line.trim();
  if (id === '' ) continue;
  if (id === 'QUIT') break;
  try {
    const [verdict, note] = await runMutant(id);
    say(`RESULT ${id} ${verdict} ${note}`);
  } catch (error) {
    say(`RESULT ${id} broken ${String(error?.message ?? error).split('\n')[0]}`);
  }
  say('READY');
}
await vitest.close();
process.exit(0);
