# Environments

Three long-lived branches. Code only ever moves in one direction.

```
feature/*  →  dev  →  staging  →  main
                                  (production)
```

| Branch    | Purpose                                                           | Database              | Doppler config |
| --------- | ----------------------------------------------------------------- | --------------------- | -------------- |
| `dev`     | Integration branch. Features and fixes merge here.                | Local Docker Postgres | `dev`          |
| `staging` | Release candidate. End-to-end tested against real infrastructure. | Neon (staging)        | `stg`          |
| `main`    | What users are on.                                                | Neon (production)     | `prd`          |

`main` is production. There is no separate `prod` branch.

## Day-to-day

```bash
git switch dev && git pull
git switch -c feature/thing      # branch from dev, always
# ...work...
git push -u origin feature/thing # open a PR into dev
```

Promotion is a PR between long-lived branches — never a direct push:

```bash
# dev → staging, when a batch is ready to be end-to-end tested
gh pr create --base staging --head dev --title "release: promote dev to staging"

# staging → main, once staging looks good
gh pr create --base main --head staging --title "release: promote staging to production"
```

Because promotion is a merge and never a rebase or squash, the three branches
share history and the diffs stay small and readable.

## What CI runs

| Job                          | Runs on                   | Purpose                                                                                                                                  |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Lint, Type Check, Unit Tests | every branch and PR       | fast feedback                                                                                                                            |
| Build                        | after those pass          | catches what tests can't                                                                                                                 |
| Migrations                   | every branch and PR       | applies migrations to a throwaway Postgres, then seeds it — so a broken migration, or a schema the writes violate, never reaches staging |
| API                          | every branch and PR       | route handlers over real HTTP; browserless, so it stays fast                                                                             |
| E2E (browser)                | `staging` and `main` only | chromium smoke test of the public pages; slow, runs where it matters                                                                     |
| Release                      | `main` pushes only        | semantic-release tags and writes notes                                                                                                   |

No deploy step yet — that's deliberate, pending a hosting decision. When it's
added, it hangs off the `build` job per branch.

## Local setup

```bash
pnpm db:up            # start Postgres in Docker
pnpm db:migrate       # apply migrations (Doppler supplies DATABASE_URL)
pnpm dev:doppler      # dev server with secrets injected
pnpm db:down          # stop Postgres
```

`pnpm dev` and `pnpm build` still work without Doppler — every integration in
`src/env.ts` is optional, so a bare checkout runs. You only need Doppler once a
surface actually depends on a secret.

## Secrets

Doppler, one config per environment (`dev`, `stg`, `prd`), under the `bramble`
project. `doppler.yaml` pins this checkout to `dev`.

```bash
doppler login
doppler setup             # selects bramble / dev from doppler.yaml
doppler secrets           # view
```

CI does **not** use Doppler. Every quality gate runs with
`SKIP_ENV_VALIDATION=true` against a throwaway database, so no production
secret is ever exposed to a workflow run.

### `CONTACT_HASH_SECRET`

`persons.sourceContactRef` is an HMAC of a phone number or email, not a plain
digest — a plain digest of a phone number is not meaningfully one-way, since the
North American keyspace is about 10^10 and a database dump alone would be enough
to recover every contact. Keeping the key outside the database is what makes the
hash worth anything, so it lives in Doppler like any other secret.

Two consequences worth knowing:

- **Hashing throws when it is unset** rather than falling back to an unkeyed
  digest. A weaker hash would still populate the column and still look correct,
  which is the silent failure the key exists to prevent.
- **Rotating it orphans every existing `sourceContactRef`.** The same contact
  would hash to a new value, so re-syncing would create a second `persons` row
  for everyone and cross-storyline continuity would break for all of them.
  Rotation therefore means re-hashing the column, not just changing the key.

CI sets a fixed, deliberately non-secret value: the integration tests assert that
one handle always produces one ref and that the raw handle never reaches the
column, and neither depends on the key's value.

## Test layers

| Layer       | Command                 | Covers                                       |
| ----------- | ----------------------- | -------------------------------------------- |
| Unit        | `pnpm test:run`         | pure logic — errors, utils, mappers          |
| Integration | `pnpm test:integration` | services and readers against a real database |
| API         | `pnpm test:api`         | route handlers over HTTP; no browser         |
| Browser     | `pnpm test:e2e`         | the public pages render                      |

The API project uses Playwright's `request` fixture only, so it never launches
a browser and needs no `playwright install` in CI.

## Migrations

Generate on `dev`, and let them promote with the code:

```bash
pnpm db:generate     # writes SQL to src/db/drizzle/
pnpm db:migrate      # applies to your local database
pnpm db:seed         # rebuilds the demo fixture (local hosts only)
```

`db:seed` refuses any non-local database and deletes its own seed user before
rebuilding, so it is safe to re-run. CI runs it after every migration, which is
what stops it rotting as the schema changes.

Commit the generated SQL. CI proves every migration applies cleanly from
scratch on each branch, so a migration that only works against your laptop
fails before it reaches staging.

Migrations are forward-only — to undo one, write a new one.

## Branch protection

`staging` and `main` are protected. `dev` is not — push to it freely.

- **Required status checks**: Lint, Type Check, Unit Tests, Build, Migrations,
  API Tests. A commit cannot land on a protected branch unless those passed
  **for that exact commit SHA**.
- **Force pushes and deletions blocked.**
- **No pull request required.** Promotion is a plain fast-forward push.
- **Admins are not forced to comply**, so you always have an escape hatch.

Because checks are tied to the commit SHA, the fast-forward flow works without
ceremony: `dev` earns green checks, and promoting that same commit to `staging`
or `main` already satisfies them.

```bash
git switch staging && git merge dev --ff-only && git push origin staging
git switch main && git merge staging --ff-only && git push origin main
```

`E2E Tests` is deliberately **not** a required check. It is skipped on `dev`, so
requiring it would block every promotion of a commit that was verified there.
It still runs on `staging` and `main`, and on PRs targeting them.

Add `required_pull_request_reviews` and set `enforce_admins: true` when someone
else joins the repo.

The default branch is `dev`, so new pull requests target it automatically.
