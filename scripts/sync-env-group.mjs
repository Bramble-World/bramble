/**
 * Pushes the Doppler `prd` config into Porter's `bramble-prd` environment group.
 *
 * Drives the `porter` CLI rather than Porter's REST API, because environment
 * groups have no documented REST endpoint — the cluster-scoped path that looks
 * like one answers 500. `porter env create` is the supported route, and the CLI
 * authenticates from `PORTER_TOKEN`, so this needs no browser login.
 *
 * Doppler is the source of truth for every production secret, and Porter needs
 * its own copy to inject into the containers. Doing that by hand means a dozen
 * dashboard fields re-typed on every rotation, which is how a staging value ends
 * up in production — so it is a script, and the script is the only way it should
 * be done.
 *
 *   doppler run --config prd -- node scripts/sync-env-group.mjs [--dry-run]
 *
 * **The plain/secret split is not cosmetic.** Porter withholds *secrets* from the
 * Docker build and exposes only plain variables to it. Every `NEXT_PUBLIC_*`
 * value is compiled into the JavaScript, so one marked secret does not fail — it
 * is silently absent and the bundle is built without it. Those are listed as
 * public below, which is correct on its own terms: a publishable key and a DSN
 * are shipped to every client that loads the page.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PROJECT = 19721;
const CLUSTER = 6001;
const GROUP = 'bramble-prd';

/**
 * Values that must reach the Docker build, and are safe to.
 *
 * Everything not listed here is sent as a secret. The default is secrecy on
 * purpose: forgetting to add a name here breaks a build visibly, while
 * forgetting to *remove* one would quietly publish a credential.
 */
const PUBLIC = new Set([
  'BRAMBLE_AI_MODE',
  'MIN_MACOS_BUILD',
  'POSTHOG_HOST',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'MACOS_DOWNLOAD_URL',
  'MACOS_BUILD_LABEL',
]);

/**
 * Deployment tooling, not application config.
 *
 * `PORTER_API_KEY` is the credential used to perform this sync. Copying it into
 * the environment the application runs in would hand every container the ability
 * to redeploy the cluster, which is a much larger blast radius than anything the
 * app needs.
 */
const EXCLUDE = new Set(['PORTER_API_KEY', 'SENTRY_AUTH_TOKEN']);

/** What `src/env.ts` actually reads, so a typo in Doppler is caught here. */
const KNOWN = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'IMPORT_MASTER_KEY',
  'CONTACT_HASH_SECRET',
  'IMPORT_WORKER_CONCURRENCY',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'OPENAI_API_KEY',
  'BRAMBLE_AI_MODE',
  'MIN_MACOS_BUILD',
  'BETA_ACCESS_CODE',
  'MACOS_DOWNLOAD_URL',
  'MACOS_BUILD_LABEL',
  'POSTHOG_PROJECT_TOKEN',
  'POSTHOG_HOST',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
]);

/** Required for the app to work at all. Reported, never guessed at. */
const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'IMPORT_MASTER_KEY',
  'CONTACT_HASH_SECRET',
  'CLERK_SECRET_KEY',
  'CLERK_WEBHOOK_SIGNING_SECRET',
  'OPENAI_API_KEY',
  'BRAMBLE_AI_MODE',
];

const token = process.env.PORTER_API_KEY;
if (!token) {
  throw new Error('PORTER_API_KEY is not set. Run this under `doppler run --config prd --`.');
}

const dryRun = process.argv.includes('--dry-run');

const variables = {};
const secrets = {};

for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith('DOPPLER_') || EXCLUDE.has(name) || !KNOWN.has(name)) continue;
  (PUBLIC.has(name) ? variables : secrets)[name] = value;
}

/**
 * Names Doppler holds that nothing in `src/env.ts` reads.
 *
 * Asked of Doppler rather than inferred from `process.env`, which under
 * `doppler run` also contains the whole shell — PATH, TERM, every VSCODE_*. The
 * point is to catch a misspelling in the config, and a check that reports fifty
 * shell variables every run is a check nobody reads.
 */
async function unknownInDoppler() {
  const config = process.env.DOPPLER_CONFIG;
  if (!config) return [];

  try {
    const { stdout } = await run('doppler', [
      'secrets',
      '--no-check-version',
      '--config',
      config,
      '--only-names',
      '--json',
    ]);
    return Object.keys(JSON.parse(stdout)).filter(
      (name) => !name.startsWith('DOPPLER_') && !EXCLUDE.has(name) && !KNOWN.has(name)
    );
  } catch {
    // Doppler absent or not logged in. The sync is the job; this is a courtesy.
    return [];
  }
}

const unknown = await unknownInDoppler();

const missing = REQUIRED.filter((name) => !(name in variables) && !(name in secrets));

console.log(`group:   ${GROUP}  (project ${PROJECT}, cluster ${CLUSTER})`);
console.log(`public:  ${Object.keys(variables).sort().join(', ') || '(none)'}`);
console.log(`secret:  ${Object.keys(secrets).sort().join(', ') || '(none)'}`);
if (missing.length) console.log(`MISSING (required): ${missing.join(', ')}`);

/**
 * Builds the argv for the CLI.
 *
 * `execFile` rather than a shell string, so no value is ever parsed by a shell —
 * a connection string contains `?`, `&` and `@`, and one of those in a shell
 * command is a silent truncation at best.
 *
 * Values do still appear in this process's argv, which is readable by other
 * processes on the same machine for the second or so the call takes. That is
 * accepted here because the alternative — the CLI has no stdin or file input for
 * these — is typing them into a dashboard by hand, which is worse in every way
 * that matters.
 */
function argvFor(command, extra) {
  return [
    'env',
    command,
    ...extra,
    // `create` only. `env set` has no such flag and exits 1 on an unknown one.
    ...(command === 'create' ? ['--no-input'] : []),
    '--project',
    String(PROJECT),
    '--cluster',
    String(CLUSTER),
    '--token',
    token,
    ...Object.entries(variables).flatMap(([k, v]) => ['-v', `${k}=${v}`]),
    ...Object.entries(secrets).flatMap(([k, v]) => ['-s', `${k}=${v}`]),
  ];
}

/**
 * Every value being sent, longest first, for redaction.
 *
 * Longest first so that a value which contains another — a connection string
 * holding a password, say — is masked before the shorter one turns it into a
 * half-redacted string that still shows the rest.
 */
const sensitive = Object.values(secrets)
  .filter((value) => value && value.length >= 8)
  .sort((a, b) => b.length - a.length);

/**
 * The CLI's own output, with every secret value masked.
 *
 * It echoes back the keys *and values* it was given — `Updated keys:
 * FOO=bar` — so its output cannot be printed as-is. Printing nothing was worse:
 * the first real failure here was an unknown flag, and "exit 1" sent me to
 * reproduce by hand what the CLI had already said plainly.
 */
function redact(text) {
  return sensitive.reduce((out, value) => out.split(value).join('«redacted»'), text ?? '');
}

async function porter(argv, label) {
  try {
    const { stdout } = await run('porter', argv, { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const detail = typeof error?.code === 'number' ? `exit ${error.code}` : 'failed to run';
    const said = redact(`${error?.stderr ?? ''}${error?.stdout ?? ''}`)
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n');
    throw new Error(`porter env ${label}: ${detail}\n${said}`);
  }
}

if (dryRun) {
  if (unknown.length) console.log(`\nnot in src/env.ts, so not sent: ${unknown.join(', ')}`);
  console.log('\n--dry-run: nothing sent.');
  process.exit(missing.length ? 1 : 0);
}

const listed = await porter(
  ['env', 'list', '--project', String(PROJECT), '--cluster', String(CLUSTER), '--token', token],
  'list'
);
const exists = listed.split('\n').some((line) => line.split(/\s+/).includes(GROUP));

// `set` on an existing group rather than `create`, which would either fail or
// replace it — and replacing is how a variable that was added by hand in the
// dashboard disappears without anyone touching this script.
await porter(
  exists ? argvFor('set', ['--group', GROUP]) : argvFor('create', ['--name', GROUP]),
  exists ? 'set' : 'create'
);

console.log(`\n${exists ? 'updated' : 'created'} ${GROUP}.`);
if (unknown.length) console.log(`not in src/env.ts, so not sent: ${unknown.join(', ')}`);
if (missing.length) {
  console.log('Still incomplete — a deploy fails at predeploy on the missing values above.');
  process.exit(1);
}
