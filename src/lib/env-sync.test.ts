import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every variable the server reads must be one the env sync sends to Porter.
 *
 * `scripts/sync-env-group.mjs` keeps its own list (`KNOWN`) and quietly skips
 * anything else, reporting it only as "not in src/env.ts, so not sent". A
 * variable added to `src/env.ts` and not to that list therefore never reaches
 * production, with nothing failing: `POOL_WORKER_CONCURRENCY` did exactly that.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Pinned in the Dockerfile, never synced. */
const NOT_SYNCED = new Set(['NODE_ENV']);

describe('the env sync', () => {
  it('sends every variable src/env.ts reads', () => {
    const env = read('src/env.ts');
    const runtime = env.slice(env.indexOf('runtimeEnv: {'));
    const read_ = new Set(
      [...runtime.slice(0, runtime.indexOf('}')).matchAll(/(\w+): process\.env\.\1/g)].map(
        (m) => m[1]
      )
    );

    const sync = read('scripts/sync-env-group.mjs');
    const block = sync.slice(sync.indexOf('const KNOWN = new Set(['));
    const known = new Set(
      [...block.slice(0, block.indexOf(']);')).matchAll(/'(\w+)'/g)].map((m) => m[1])
    );

    expect(read_.size).toBeGreaterThan(20);
    const missing = [...read_].filter((name) => !NOT_SYNCED.has(name) && !known.has(name));
    expect(missing).toEqual([]);
  });
});
