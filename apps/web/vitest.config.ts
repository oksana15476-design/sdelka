import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/** Тот же алиас, что у сборщика Next: тесты обязаны видеть модули так же. */
export default defineConfig({
  resolve: {
    alias: { '@': resolve(here, 'src') },
  },
});
