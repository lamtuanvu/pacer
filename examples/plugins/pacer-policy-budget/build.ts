import { chmodSync } from 'node:fs';
import { join } from 'node:path';

const result = await Bun.build({ entrypoints: [join(import.meta.dir, 'index.ts')], target: 'bun', outdir: join(import.meta.dir, 'dist'), naming: 'main.js' });
if (!result.success) throw new AggregateError(result.logs, 'Budget policy example build failed');
chmodSync(join(import.meta.dir, 'dist/main.js'), 0o755);
