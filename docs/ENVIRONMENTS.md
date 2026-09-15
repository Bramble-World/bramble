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

| Job                          | Runs on                   | Purpose                                                                                 |
| ---------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| Lint, Type Check, Unit Tests | every branch and PR       | fast feedback                                                                           |
| Build                        | after those pass          | catches what tests can't                                                                |
| Migrations                   | every branch and PR       | applies migrations to a throwaway Postgres, so a broken migration never reaches staging |
| API                          | every branch and PR       | route handlers over real HTTP; browserless, so it stays fast                            |
| E2E (browser)                | `staging` and `main` only | chromium smoke test of the public pages; slow, runs where it matters                    |
| Release                      | `main` pushes only        | semantic-release tags and writes notes                                                  |

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
```

Commit the generated SQL. CI proves every migration applies cleanly from
scratch on each branch, so a migration that only works against your laptop
fails before it reaches staging.

Migrations are forward-only — to undo one, write a new one.

## Branch protection

Set on GitHub for `staging` and `main`:

- Require a pull request before merging
- Require status checks: Lint, Type Check, Unit Tests, Build, Migrations, API Tests
- Disallow force pushes
