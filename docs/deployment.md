# Deploying the Bramble API

The backend runs on Porter (AWS EKS) as **one image started four ways**: the web
server, the import worker, and two scheduled sweeps. `porter.yaml` is the whole
deployment; this document is the part that cannot live in it, namely where each
secret comes from and which ones are needed before the image is even built.

|                    |                                                                      |
| ------------------ | -------------------------------------------------------------------- |
| **Porter project** | `19721` (`bramble`)                                                  |
| **Cluster**        | `6001` — `porter-bramble-spy-cat`, EKS, `us-east-1`                  |
| **Registry**       | `237162087904.dkr.ecr.us-east-1.amazonaws.com` — ECR, Porter-managed |
| **Image**          | `Dockerfile`, multi-stage, Node 22 Alpine, non-root, port 3000       |
| **Manifest**       | `porter.yaml`                                                        |
| **Env group**      | `bramble-prd`, filled from the Doppler `prd` config                  |
| **Domain**         | `api.brambleworld.com`                                               |
| **Database**       | RDS Postgres 16, TLS verified against the bundled AWS CA             |
| **Cache**          | ElastiCache Redis, `rediss://`                                       |

## The four processes

| Process    | Command                                  | Notes                                                       |
| ---------- | ---------------------------------------- | ----------------------------------------------------------- |
| Web        | `node server.js`                         | 2 replicas. Liveness `/api/health`, readiness `/api/ready`. |
| Worker     | `node dist/worker/import-worker.js`      | 1 replica. No port — it polls the `imports` table.          |
| Migrations | `node dist/db/migrate.js`                | Porter `predeploy`. Non-zero exit blocks the release.       |
| Sweeps     | `node dist/sweeps/{arc,import}-sweep.js` | Cron jobs, hourly and every ten minutes.                    |

One image rather than four, so the worker cannot be running different code from
the server that queued its work. The worker and the sweeps are bundled with
esbuild into `dist/` (`scripts/build-server.mjs`) precisely so the runtime image
needs no dev dependencies: without that, running a `.ts` entrypoint would mean
shipping `tsx` and `typescript` to production so that four files can be read.

### There is no job queue

The `imports` row **is** the queue. A worker claims the oldest claimable row with
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, which is what
lets replicas be added without them fighting over the head of the queue.

This is a privacy decision as much as an architectural one. A queue stores its
payloads, shows them in a dashboard and writes them to run logs — and the one
thing this system must not do is keep a transcript anywhere but the encrypted
Redis store it has a TTL on. Removing the broker removes a store.

Retries live on the row: `imports.attempts` (budget of 3) and
`imports.next_attempt_at` (backoff, 5s then 10s). Both are columns rather than
worker state because the attempt that gives up is rarely the attempt that
started.

## Build-time vs runtime

This distinction is the one that causes real confusion, so it is worth being
blunt about: **`NEXT_PUBLIC_*` values are compiled into the JavaScript.** Setting
them on a running container does nothing, because the code was already built
without them. They are Docker build arguments, and changing one means a rebuild.

### Build arguments

All optional. **A build with none of them set must succeed** — that is what lets
CI build this image with no secrets at all, which is the only way a broken
Dockerfile gets caught before a deploy.

| Build arg                           | Source                             | Purpose                                                                   |
| ----------------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`               | — (`https://api.brambleworld.com`) | Absolute URLs in responses and emails.                                    |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk prod                         | Clerk's client key. Public by design.                                     |
| `NEXT_PUBLIC_SENTRY_DSN`            | Sentry                             | Enables Sentry. Also gates the build plugin — no DSN, no source-map step. |

### Build secret

| Secret              | Source | Purpose              |
| ------------------- | ------ | -------------------- |
| `SENTRY_AUTH_TOKEN` | Sentry | Uploads source maps. |

**On Porter specifically: this one does not arrive.** Porter's build does not
receive the application's secrets — _"Secrets will not be made available to your
build process"_ — and there is no Docker build-secret mechanism in its Dockerfile
builds. The build therefore succeeds and skips the upload, which is the
degradation the Dockerfile was written for: Sentry still captures errors, because
the DSN is a build _argument_; what is missing is symbolicated stack traces.

Two ways to close that, neither required to ship:

- add `PORTER_SENTRY_AUTH_TOKEN` to the generated GitHub Actions workflow from a
  repository secret — Porter passes through supplementary variables prefixed
  `PORTER_` — and read it in the Dockerfile alongside the secret mount;
- or upload source maps from a separate CI step with `sentry-cli`, outside the
  image build entirely.

The token is deliberately **not** an `ARG`. An `ARG` is recorded in the image's
build history and readable with `docker history` by anyone who can pull the image,
which is worse than having no source maps.

Mounted with `--mount=type=secret`, **never as a build arg**. An `ARG` is recorded
in the image's build history and readable with `docker history` by anyone who can
pull the image; a secret mount exists only for the duration of one `RUN` and is
never written to a layer. Builds succeed without it — a release without source
maps is still a release.

**On Porter, these come from the application's environment, not from a `docker
build` command.** Porter exposes environment variables to the build through the
`ARG` declarations already in the Dockerfile — but it withholds _secrets_. So each
of these must be added as a **plain variable, never a secret**, or it is silently
absent and the client bundle is compiled without it. All three are public by
definition: a publishable key and a DSN ship to every client that loads the page.

`NEXT_PUBLIC_APP_URL` is set in `porter.yaml`'s own `env:` block instead, since it
is both public and ours — one fewer dashboard field to get wrong.

Locally, where there is no Porter, they are ordinary build arguments:

```bash
docker build \
  --build-arg NEXT_PUBLIC_APP_URL=https://api.brambleworld.com \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$CLERK_PK" \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="$SENTRY_DSN" \
  --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  -t bramble:local .
```

## Runtime environment

Set on the `bramble-prd` environment group, which every process shares. Shared
rather than per-service on purpose: the worker and the web process need almost the
same set, and a variable that exists for one and not the other shows up as an
import failing in a way no request does.

Each row says which processes actually read it, so a variable can be removed with
confidence rather than left in place forever because nobody is sure.

### Required

| Variable                       | Read by                | Source                   | Purpose                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | all                    | AWS RDS                  | Postgres. **Must end `?sslmode=require`** — see TLS below.                                                                                                                                                                         |
| `REDIS_URL`                    | web, worker, sweeps    | AWS ElastiCache          | `rediss://…` Where encrypted transcripts wait between the import request and the worker.                                                                                                                                           |
| `IMPORT_MASTER_KEY`            | web, worker            | generated, Doppler `prd` | Base64, 32 bytes. Wraps every per-import data key. Deliberately a different secret from `REDIS_URL`: envelope encryption is pointless if the key sits beside the credentials that reach the ciphertext. `openssl rand -base64 32`. |
| `CONTACT_HASH_SECRET`          | web, worker            | generated, Doppler `prd` | ≥32 chars. HMAC key for `persons.source_contact_ref`. Hashing throws without it rather than falling back to an unkeyed digest. **Rotating it orphans every existing person row.**                                                  |
| `CLERK_SECRET_KEY`             | web                    | Clerk prod               | `sk_live_…`. Verifies bearer tokens. Without it every request is a 401.                                                                                                                                                            |
| `CLERK_WEBHOOK_SIGNING_SECRET` | web                    | Clerk prod → Webhooks    | `whsec_…`. Verifies the Clerk webhook. Without it the route rejects everything, which is the correct closed default. See _Clerk webhook_ below.                                                                                    |
| `OPENAI_API_KEY`               | web, worker, arc-sweep | OpenAI                   | `sk-…`. The model. Without it the generator falls back to a deterministic fake — which is worse than failing, because it is invisible.                                                                                             |
| `BRAMBLE_AI_MODE`              | web, worker, arc-sweep | set to `live`            | **Set this explicitly.** It forces the fake when set to `fake`; `live` in production states the intent rather than relying on a key being present.                                                                                 |

### Expected, with defaults worth setting explicitly

| Variable                    | Default      | Set to       | Purpose                                                                                                                                          |
| --------------------------- | ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                  | `production` | `production` | Pinned in the Dockerfile too. Its only other job is gating `/lab`, which must never be reachable in production — hence the default.              |
| `MIN_MACOS_BUILD`           | `0`          | `0`          | Oldest macOS build served. `0` serves every client. A wrong value locks out every client at once, so raise it only with a release ready.         |
| `IMPORT_WORKER_CONCURRENCY` | `2`          | leave unset  | Imports extracted per worker at once. Queue depth is better answered with another replica than with one process holding more work it could lose. |

### Optional

| Variable                | Read by     | Source          | Purpose                                                                                                                           |
| ----------------------- | ----------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_PROJECT_TOKEN` | web, worker | PostHog         | Product analytics. Absent means analytics are off, which is a supported state.                                                    |
| `POSTHOG_HOST`          | web, worker | PostHog         | Region host, e.g. `https://us.i.posthog.com`.                                                                                     |
| `CLERK_JWT_KEY`         | web         | Clerk prod      | PEM public key. Verifies session JWTs in-process instead of fetching JWKS per request. A latency optimisation, not a requirement. |
| `BETA_ACCESS_CODE`      | web         | chosen          | ≥6 chars. Gates the macOS download page.                                                                                          |
| `MACOS_DOWNLOAD_URL`    | web         | release hosting | Where the signed `.dmg` lives.                                                                                                    |
| `MACOS_BUILD_LABEL`     | web         | release         | Human-readable build on the download page.                                                                                        |

### Never set in production

`DATABASE_CA_PATH` only needs setting for a Postgres that is not RDS. `LAB_*` and
the seed variables are development-only.

## Postgres TLS

`DATABASE_URL` must carry `?sslmode=require`, and the certificate is **verified**:
the AWS RDS global CA bundle is vendored at `certs/rds-global-bundle.pem` and
copied into the image at `/etc/ssl/certs/rds-global-bundle.pem`.

The trap is worth stating precisely, because the obvious reading of it is wrong
and the wrong version fails at `predeploy`.

**`pg-connection-string` builds its own `ssl` config whenever the URL contains
`sslmode`** — or `sslrootcert`, `sslcert`, `sslkey` — and that _replaces_ any
`ssl` passed alongside the connection string. So this silently discards the CA:

```ts
// WRONG: the ca is thrown away, and the handshake fails with
// "unable to verify the first certificate".
drizzle({ connection: { connectionString: '…?sslmode=require', ssl: { ca } } });
```

Separately, libpq's `sslmode=require` means "encrypt, but do not check who you are
talking to" — an encrypted connection to anyone who can answer on the port — and
older `pg` implemented exactly that with `rejectUnauthorized: false`. Newer
versions are mid-migration toward libpq-compatible semantics and warn about every
mode but `verify-full`.

`src/db/ssl.ts` therefore does neither. `postgresConnection(url)` **strips the ssl
parameters out of the URL** and returns the config itself, so the driver gets a
plain URL and an explicit `ssl` object — the one shape whose behaviour does not
change between versions:

```ts
const connection = postgresConnection(env.DATABASE_URL ?? placeholder);
export const db = drizzle({ connection, relations });
```

It **throws rather than falling back** when the CA cannot be read. A process that
will not start is the right answer to being unable to verify the database it is
about to talk to; the tempting fallback would turn a missing file into a silently
unverified production database.

Verified against a real TLS Postgres (pg 8.23.0, pg-connection-string 2.14.0),
with the second case proving verification is actually active rather than cosmetic:

|                                                               |                                             |
| ------------------------------------------------------------- | ------------------------------------------- |
| correct CA                                                    | connects, TLS 1.3, `pg_stat_ssl.ssl = true` |
| **wrong CA** (the real RDS bundle against a different server) | **rejected**                                |
| CA file missing                                               | refuses before opening a socket             |
| `sslmode=disable`                                             | plaintext, for a local database             |

The bundle is vendored rather than fetched during the build so that neither a
build nor a CI run depends on `truststore.pki.rds.amazonaws.com` being reachable.
Its roots run to 2061; refreshing it is a commit:

```bash
curl -fsS -o certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

`DATABASE_CA_PATH` overrides the path for a Postgres that is not on RDS. An empty
value falls back to the bundled path, since a blank variable is what a templated
env group produces rather than a request to read `''`.

## Redis

ElastiCache with in-transit encryption, so `rediss://`. ioredis turns the scheme
into TLS against the system trust store, which is correct here because ElastiCache
certificates come from a public CA — unlike RDS, which is why only Postgres needs
a bundle.

The client (`src/lib/redis/client.ts`) reconnects indefinitely with a two-second
ceiling, rather than ioredis's default of giving up after twenty attempts. A
client that has given up never comes back, so every import after a failover would
fail on a dead connection until the process was restarted. `READONLY` triggers a
reconnect, since that is the first sign ElastiCache has promoted a replica.

Non-cluster mode is assumed — one primary endpoint. Cluster mode would need
`Redis.Cluster`.

## Clerk webhook

Point the Clerk **production** instance at:

```
https://api.brambleworld.com/api/webhooks/clerk
```

Copy the generated signing secret into `CLERK_WEBHOOK_SIGNING_SECRET`. The route
verifies every delivery and rejects unsigned requests, so an absent secret means
nothing gets through — closed by default, and silent. If user records stop
appearing, check this first.

## Health checks

| Endpoint      | Answers                           | Checks                                                    |
| ------------- | --------------------------------- | --------------------------------------------------------- |
| `/api/health` | should this process be restarted? | nothing outside the process                               |
| `/api/ready`  | should traffic come here?         | Postgres `SELECT 1` + Redis `PING`, 2s budget, 200 or 503 |

They are deliberately different. A dependency check wired to liveness restarts
every replica the moment Postgres blips, turning a brief outage into a cold start
under load. Readiness takes one replica out of rotation instead. `/api/ready`
names the failed dependency (`{"status":"unavailable","failed":["redis"]}`) and
never the error behind it, because both clients put connection strings — and
therefore credentials — into their messages.

## Graceful shutdown

`terminationGracePeriodSeconds: 960` on the worker is **load-bearing, not
padding**. On SIGTERM the worker stops claiming and lets in-flight extractions
finish. If the platform kills it first, that promise is decoration: a paid-for
model call is wasted and the row waits out its fifteen-minute reclaim window
before another worker picks it up. Keep it above `IMPORT_TIMEOUT_MS` in
`src/worker/import-worker.ts`.

The web service gets 180s for the same reason at a smaller scale — a turn is a
model call, and killing one mid-flight bills for nothing.

## Applying the manifest

`porter.yaml` is not read automatically — something has to apply it. The project
id is **not** a field in the manifest (it has no such key); it is passed to the
CLI, which is why it is recorded here instead.

```bash
PORTER_TOKEN="$PORTER_DEPLOY_TOKEN" \
PORTER_PROJECT=19721 \
PORTER_CLUSTER=6001 \
porter apply -f porter.yaml
```

| Variable         | Value        | Source                                                                                            |
| ---------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `PORTER_PROJECT` | `19721`      | the Porter project                                                                                |
| `PORTER_CLUSTER` | `6001`       | the EKS cluster's id in Porter                                                                    |
| `PORTER_TOKEN`   | _(a secret)_ | a Porter API token. A GitHub Actions secret — **never a committed value, and never in this file** |
| `PORTER_TAG`     | optional     | an image tag to deploy instead of building                                                        |

Linking the repository in Porter's dashboard generates a
`.github/workflows/porter_stack_bramble.yml` that does this on every push to the
deploy branch, and fills all three values itself. That is the intended path —
this block is for applying a manifest change by hand, and for knowing what the
generated workflow is doing.

Porter's REST API is served from **`dashboard.porter.run`**, not `api.porter.run`
— the latter answers `521` to every path, which looks like an auth failure and is
not one. Worth knowing before debugging a token that is fine:

```bash
curl -H "Authorization: Bearer $PORTER_TOKEN" \
  https://dashboard.porter.run/api/projects/19721/clusters
```

Note that CI's `Docker Image` job is **not** a deploy: it builds the image and
throws it away, with no registry credentials involved, so that a broken
Dockerfile fails the pull request. Porter does its own build from this same
Dockerfile.

## First deploy

The order matters in one place: **`predeploy` runs the migrations, so the
datastores and the environment group have to exist before the first deploy.**
Deploying earlier fails on a missing `DATABASE_URL` — correctly, but confusingly.

1. **Datastores.** Create Postgres and Redis in Porter (project `19721`, cluster
   `6001`) rather than in the AWS console. Porter provisions RDS and ElastiCache
   into the cluster's own VPC and attaches the security groups itself, so the app
   can reach them with no networking by hand — which is the whole reason to do it
   this way, and why no AWS credentials are needed anywhere in this process.

   Postgres must be reachable as `…?sslmode=require` (see _Postgres TLS_), and
   Redis as `rediss://`, which means enabling in-transit encryption when you
   create it — it cannot be turned on afterwards without replacing the cluster.

2. **Secrets.** Generate the two that are ours:

   ```bash
   openssl rand -base64 32   # IMPORT_MASTER_KEY
   openssl rand -base64 32   # CONTACT_HASH_SECRET  (any ≥32 chars)
   ```

   Put them, both connection strings, and everything else under _Runtime
   environment_ into Doppler `prd`, which starts empty.

3. **Environment group.** `bramble-prd` — the name must match `envGroups` in
   `porter.yaml`, and Porter requires it to exist _before_ a deploy references it.

   Run the sync rather than filling it in by hand. Doppler is the source of truth,
   and a dozen dashboard fields re-typed on every rotation is how a staging value
   reaches production:

   ```bash
   doppler run --config prd -- node scripts/sync-env-group.mjs --dry-run   # inspect
   doppler run --config prd -- node scripts/sync-env-group.mjs             # apply
   ```

   It exits non-zero and names what is still missing, so it doubles as the
   readiness check for everything above. It needs the Porter CLI
   (`brew install porter-dev/porter/porter`) and authenticates from
   `PORTER_API_KEY` in Doppler — no browser login.

   The script owns the plain/secret split, which is the part that must not be done
   by hand: Porter withholds secrets from the Docker build, and the `NEXT_PUBLIC_*`
   values have to reach it. See the `PUBLIC` set in the script.

   Environment groups have **no REST API** — `porter env create` is the only
   supported route besides the dashboard, and the cluster-scoped endpoint that
   looks like one answers 500. Groups are project-scoped and synced to AWS Secrets
   Manager, so they do not appear in the legacy cluster-scoped listing either.

4. **Link the repository.** In Porter, point the app at `Bramble-World/bramble`
   and the `main` branch. Porter commits a
   `.github/workflows/porter_stack_bramble.yml` that builds from this `Dockerfile`
   and applies this `porter.yaml` on every push, filling `PORTER_PROJECT`,
   `PORTER_CLUSTER` and `PORTER_TOKEN` itself. This is the intended path; the
   `porter apply` block above is for applying a manifest change by hand.

5. **Deploy.** The first run builds the image, runs `predeploy`
   (`node dist/db/migrate.js`) against the empty database, and starts the four
   processes. A failed migration exits non-zero and blocks the release rather than
   letting new code meet an old schema.

6. **Domain.** Point `api.brambleworld.com` at the web service.

7. **Clerk webhook.** Only now, because it needs the domain to resolve: add
   `https://api.brambleworld.com/api/webhooks/clerk` to the Clerk **production**
   instance and copy the signing secret into `CLERK_WEBHOOK_SIGNING_SECRET`.
   Without it the route rejects every delivery — closed by default, and silent, so
   if user records stop appearing this is the first thing to check.

8. **Verify.**

   ```bash
   curl https://api.brambleworld.com/api/health   # {"status":"ok"}
   curl https://api.brambleworld.com/api/ready    # {"status":"ok"}
   ```

   A 503 from `/api/ready` names the dependency that is not wired up. A **500**
   means something else entirely, because an unconfigured dependency is a 503 by
   design — so a 500 here is a bug, not a configuration gap.

   Then watch the worker's logs for `worker_started`. It polls every two seconds
   and logs nothing until an import arrives, so silence is the healthy state.

## Rolling back

`autoRollback` is not enabled in `porter.yaml`, so a bad release stays up. Roll
back from Porter's dashboard, or redeploy a known-good image tag with
`PORTER_TAG`.

**Migrations do not roll back.** Drizzle generates forward-only SQL and there are
no down migrations, so a deploy that drops or rewrites a column cannot be undone
by reverting the code. Treat a destructive migration as a separate, deliberate
release: ship the additive half first, let it run, then remove what is unused.

## Verifying a change locally

```bash
# Builds with nothing configured — the property CI relies on.
docker build -t bramble:local .

# Web, against a local Postgres and Redis.
docker run --rm -p 3000:3000 --env-file .env.local bramble:local
curl localhost:3000/api/health && curl localhost:3000/api/ready

# The same image, started the other three ways.
docker run --rm --env-file .env.local bramble:local node dist/db/migrate.js
docker run --rm --env-file .env.local bramble:local node dist/worker/import-worker.js
docker run --rm --env-file .env.local bramble:local node dist/sweeps/import-sweep.js
```

Locally, without Doppler, `pnpm dev:all` runs the Next dev server and the worker
together; `pnpm worker` runs the worker alone, and `pnpm sweep:arc` /
`pnpm sweep:imports` run the sweeps on demand.
