import { createVitest } from 'vitest/node';
import { buildCatalogue, MUTATION_ENV, targetFile } from '/home/user/sdelka/packages/intake/scripts/intake-mutants.mjs';

process.chdir('/home/user/sdelka/packages/intake');

const started = Date.now();
const vitest = await createVitest('test', {
  config: 'scripts/mutation.vitest.config.ts',
  watch: false,
  silent: true,
  reporters: [],
  pool: 'threads',
});
console.log('created', Date.now() - started);

globalThis.__sdelkaMutationApplied = new Set();

let PATHS = [];
async function runOnce(label) {
  globalThis.__sdelkaMutationApplied.clear();
  const t = Date.now();
  await vitest.rerunFiles(PATHS, label, true);
  const files = vitest.state.getFiles();
  const failed = files.filter((f) => f.result?.state === 'fail').length;
  console.log(label, 'files', files.length, 'failed', failed, 'ms', Date.now() - t,
    'applied', [...globalThis.__sdelkaMutationApplied]);
  return failed;
}

await vitest.start();
PATHS = vitest.state.getFilepaths();
console.log('start done', Date.now() - started, vitest.state.getFiles().length, PATHS.length);

const catalogue = buildCatalogue();
const pick = (id) => catalogue.find((m) => m.id === id);

// 1. базовый
delete process.env[MUTATION_ENV];
await runOnce('baseline-1');

// 2. мутант, который обязан упасть
const m1 = pick('policy.ts::num::5278-inc');
process.env[MUTATION_ENV] = m1.id;
invalidate(m1);
await runOnce('mutant-1');

// 3. снова базовый: должен снова зеленеть
delete process.env[MUTATION_ENV];
invalidate(m1);
await runOnce('baseline-2');

// 4. второй мутант в другом файле
const m2 = pick('route.ts::str::1832');
process.env[MUTATION_ENV] = m2.id;
invalidate(m2);
await runOnce('mutant-2');

function invalidate(mutant) {
  const file = targetFile(mutant);
  let count = 0;
  for (const project of vitest.projects ?? [vitest.getCoreWorkspaceProject?.()]) {
    const server = project.server ?? project.vite;
    if (!server) continue;
    const mod = server.moduleGraph.getModuleById(file);
    if (mod) {
      server.moduleGraph.invalidateModule(mod, new Set(), Date.now(), true);
      count += 1;
    }
  }
  console.log('invalidated', file, count);
}

await vitest.close();
console.log('total', Date.now() - started);
