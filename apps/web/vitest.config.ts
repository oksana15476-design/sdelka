import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/** Тот же алиас, что у сборщика Next: тесты обязаны видеть модули так же. */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(here, 'src') },
  },
  /*
   * JSX в тестах собирается новой средой выполнения. В `tsconfig.json` стоит
   * `jsx: preserve`, потому что разметку компилирует Next; у прогона тестов
   * своего Next нет, и без этой строки компоненты падают на `React is not
   * defined` — то есть экранные проверки были бы невозможны в принципе.
   */
  esbuild: { jsx: 'automatic' },
});
