// Git's inherited GIT_* variables can override -C, select another index or inject config.
// Each caller selects its own repository and adds only the Git settings it needs.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const gitEnv = (env = process.env) => Object.fromEntries(
  Object.entries(env).filter(([key]) => !key.startsWith('GIT_')),
);

// Feature recipes use the same environment sanitizer as fixture and helper calls.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync('git', process.argv.slice(2), { env: gitEnv(), stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
