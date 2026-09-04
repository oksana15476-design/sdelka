import { generate } from '../generate.ts';

/** `pnpm db:generate`. Базы не требует: пересобирает снимок и контрольные суммы. */
const result = generate();
process.stdout.write(`checksums=${result.checksums.split('\n').filter(Boolean).length}\n`);
