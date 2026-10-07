# syntax=docker/dockerfile:1.7
#
# One image, three ways to run it: the web server, the import worker, and one-off
# commands (migrations, the two sweeps). Building one image rather than three
# means the worker cannot be running different code from the server that queued
# its work, which is the failure that a separate worker image invites.
#
# See docs/deployment.md for which build arguments and secrets this takes, and
# which environment variables each process needs at runtime.

# Node 22 to match .nvmrc. Alpine for a runtime image that is tens of megabytes
# rather than hundreds; nothing here needs glibc, since pg and ioredis are pure
# JavaScript and the Next server does not use native image processing.
FROM node:22-alpine AS base
# pnpm, at exactly the version package.json pins. corepack reads it from the
# manifest, so this cannot drift from what developers and CI use.
RUN corepack enable
WORKDIR /app


# ---- dependencies -----------------------------------------------------------
# Separated so a source-only change does not reinstall. --frozen-lockfile makes
# the build fail rather than silently resolve something new when the lockfile and
# package.json disagree.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile


# ---- build ------------------------------------------------------------------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* is inlined into the client bundle at build time, so these have to
# be arguments rather than runtime environment: setting them on the container
# would have no effect on code that was already compiled without them.
#
# Every one is optional. A build with none of them set must succeed — that is
# what lets CI build this image with no secrets at all, which is the only way a
# broken Dockerfile gets caught before a deploy.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Set for the build and not only for the runtime. `next build` renders pages with
# React's production build, and a build run with NODE_ENV=development crashes
# while prerendering Next's own error page with a null `useContext` — a failure
# that looks nothing like its cause.
ENV NODE_ENV=production

# Telemetry off: a build should not phone home, and in CI it cannot anyway.
ENV NEXT_TELEMETRY_DISABLED=1

# SENTRY_AUTH_TOKEN uploads source maps, and it is a secret mount rather than an
# ARG on purpose. An ARG is recorded in the image's build history and readable
# with `docker history` by anyone who can pull the image; a secret mount exists
# only for the duration of this one RUN and is never written to a layer.
#
# The build succeeds without it. Sentry's plugin only runs when a DSN is set
# (see next.config.ts), and without a token it skips the upload with a warning
# rather than failing — so a release without source maps is still a release.
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    pnpm build

# The worker, the sweeps and the migrator, bundled. The runtime image has no dev
# dependencies, so none of them can be run through tsx — see scripts/build-server.mjs.
RUN pnpm build:server


# ---- runtime ----------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind to every interface. Next's standalone server listens on localhost by
# default, which inside a container means nothing outside it can connect — the
# port is published and the health check still fails.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Non-root. The `node` user ships with the base image at uid 1000, so there is
# nothing to create and no uid to collide with a mounted volume's owner.
#
# Ownership is set on copy rather than with a later `chown -R`, which would
# duplicate every file it touched into a new layer.
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Static assets and `public/` are deliberately outside the standalone output,
# because the usual deployment serves them from a CDN. This one does not, so they
# have to be copied in or every asset 404s.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# The worker, sweeps and migrator, plus the SQL the migrator reads.
COPY --from=builder --chown=node:node /app/dist ./dist

# The RDS CA bundle, at the path src/db/ssl.ts looks for. Baked in rather than
# fetched at build time, so neither a build nor a boot depends on AWS's
# truststore host being reachable.
COPY --from=builder --chown=node:node /app/certs/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

USER node
EXPOSE 3000

# The web server. The worker and the one-off commands override this:
#   worker:  node dist/worker/import-worker.js
#   migrate: node dist/db/migrate.js
#   sweeps:  node dist/sweeps/arc-sweep.js | node dist/sweeps/import-sweep.js
CMD ["node", "server.js"]
