import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Walks a change up the promotion chain: dev → staging → main.
 *
 *   pnpm promote            # the whole chain
 *   pnpm promote --dry-run  # say what it would do, change nothing
 *   pnpm promote --sync     # merge main back into dev, after a hotfix
 *
 * Three promotions by hand is four rounds of "open a pull request, poll the
 * checks, merge, repeat", and the cost of that is not the typing — it is that
 * a chain abandoned half way leaves the branches diverged. That is what put a
 * `.prettierignore` conflict between `staging` and `main`, and what let `main`
 * sit 139 commits behind `dev` for weeks.
 *
 * Deliberately not a GitHub Actions workflow. A promotion is a decision, and it
 * should happen when somebody asks for it, with its output in front of them.
 */

const CHAIN = ['dev', 'staging', 'main'];

/** How long to wait for a branch's checks before giving up, in minutes. */
const CHECK_TIMEOUT_MIN = 20;
const POLL_SECONDS = 20;

const dryRun = process.argv.includes('--dry-run');
const sync = process.argv.includes('--sync');

async function sh(file, args) {
  const { stdout } = await run(file, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

/** gh with JSON out, parsed. Returns null when the command fails (e.g. no such PR). */
async function ghJson(args) {
  try {
    return JSON.parse(await sh('gh', args));
  } catch {
    return null;
  }
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/**
 * How many commits `head` has that `base` does not.
 *
 * Zero means the hop is a no-op, which is worth saying rather than opening an
 * empty pull request that cannot be merged.
 */
async function ahead(base, head) {
  return Number(await sh('git', ['rev-list', '--count', `origin/${base}..origin/${head}`]));
}

/** The open pull request for this hop, or null. */
async function existingPr(base, head) {
  const prs = await ghJson([
    'pr',
    'list',
    '--base',
    base,
    '--head',
    head,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  return prs?.[0]?.number ?? null;
}

async function openPr(base, head) {
  const title = `chore: promote ${head} to ${base}`;
  const body = `Opened by \`pnpm promote\`.\n\nPromotes \`${head}\` to \`${base}\`.`;
  await sh('gh', [
    'pr',
    'create',
    '--base',
    base,
    '--head',
    head,
    '--title',
    title,
    '--body',
    body,
  ]);
  const number = await existingPr(base, head);
  if (number === null)
    throw new Error(`opened a pull request for ${head} → ${base} but cannot find it`);
  return number;
}

/**
 * Waits until nothing is pending, then reports what happened.
 *
 * Keyed on the checks themselves rather than on `mergeStateStatus`, because a
 * failing check that is not in branch protection leaves the status `UNSTABLE`
 * forever — and `E2E Tests` and `Docker Image` are both outside it. Treating any
 * failure as a stop is the safer reading, and it closes that gap in practice
 * without touching branch protection.
 */
async function waitForChecks(number) {
  const deadline = Date.now() + CHECK_TIMEOUT_MIN * 60_000;

  while (Date.now() < deadline) {
    const pr = await ghJson([
      'pr',
      'view',
      String(number),
      '--json',
      'mergeStateStatus,statusCheckRollup',
    ]);
    if (!pr) throw new Error(`cannot read pull request #${number}`);

    if (pr.mergeStateStatus === 'DIRTY') {
      return {
        ok: false,
        reason:
          `#${number} has a merge conflict. Resolve it, then run promote again:\n` +
          `    git checkout ${CHAIN[0]} && git pull\n` +
          `    gh pr checkout ${number} && git merge origin/<base> # fix, commit, push`,
      };
    }

    const checks = (pr.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context,
      state: c.conclusion ?? c.state,
    }));
    const pending = checks.filter((c) =>
      [null, undefined, '', 'PENDING', 'IN_PROGRESS'].includes(c.state)
    );
    const failed = checks.filter((c) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.state)
    );

    if (pending.length === 0) {
      if (failed.length > 0) {
        return {
          ok: false,
          reason: `#${number} has failing checks: ${failed.map((c) => c.name).join(', ')}`,
        };
      }
      return { ok: true };
    }

    process.stdout.write(`    ${pending.length} check(s) pending…\n`);
    await sleep(POLL_SECONDS);
  }

  return {
    ok: false,
    reason: `#${number} still had checks running after ${CHECK_TIMEOUT_MIN} minutes`,
  };
}

async function promote(base, head) {
  const count = await ahead(base, head);
  if (count === 0) {
    console.log(`  ${head} → ${base}: already level, nothing to do`);
    return true;
  }

  console.log(`  ${head} → ${base}: ${count} commit(s)`);
  if (dryRun) return true;

  const reused = await existingPr(base, head);
  const number = reused ?? (await openPr(base, head));
  console.log(`    #${number}${reused ? ' (already open)' : ''}`);

  const checks = await waitForChecks(number);
  if (!checks.ok) {
    console.error(`    ${checks.reason}`);
    return false;
  }

  await sh('gh', ['pr', 'merge', String(number), '--merge']);
  console.log(`    merged`);
  return true;
}

await sh('git', ['fetch', '--prune', 'origin']);

if (sync) {
  // After a hotfix straight to main: carry it back so the chain starts level.
  // Skipping this is what produces a conflict on the next promotion.
  console.log('syncing main back into dev');
  if (!(await promote('dev', 'main'))) process.exit(1);
  console.log('done — run `pnpm promote` to carry it to staging');
  process.exit(0);
}

console.log(dryRun ? 'promotion plan (--dry-run):' : 'promoting:');
for (let i = CHAIN.length - 1; i > 0; i--) {
  const base = CHAIN[i];
  const head = CHAIN[i - 1];
  if (!(await promote(base, head))) {
    console.error('\nstopped. Nothing further was merged.');
    process.exit(1);
  }
}
console.log(dryRun ? '\n--dry-run: nothing was opened or merged.' : '\nall branches level.');
