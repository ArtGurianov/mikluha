# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.29.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: clean production build
#
# Content lives in content/ (this checked-out repo) — the build reads it
# straight off disk, no CMS credentials of any kind needed here. The only
# build-time switch left is DEPLOY_ENV, which controls indexability/canonical
# URLs, not the content source. Its default ("production") requires
# siteSettings.launchReady=true; the committed content/ (still demo data)
# needs `--build-arg DEPLOY_ENV=staging` until real content replaces it.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

ARG DEPLOY_ENV=production
ARG SITE_URL

ENV DEPLOY_ENV=$DEPLOY_ENV \
    SITE_URL=$SITE_URL \
    NEXT_TELEMETRY_DISABLED=1

COPY . .

# The one and only definition of the release pipeline lives in package.json.
# Spelling the steps out again here let the two drift apart silently: the image
# build kept running an older list and quietly skipped whole steps (lint, test)
# that build:production had since grown. Call the script, never re-list its steps.
RUN pnpm run build:production

# ---------------------------------------------------------------------------
# Stage 3: production runtime — Nginx serving the static /out only.
# No Node.js, no CMS credentials, no source code.
#
# Deliberately the *stable* branch tag, not a patch version or a digest. 1.27
# was a mainline branch, which stops getting patches as soon as the next one
# opens. And because the scheduled nightly rebuild re-runs this Dockerfile from
# scratch, a branch tag picks up nginx patch releases on its own — a pinned
# digest would freeze the runtime until someone remembered to bump it, and
# nothing here would ever remind them. Exact reproducibility buys little for a
# server that only hands out static files whose content is meant to change
# daily. The risk a floating tag carries — a bad patch landing between two
# builds of identical source — is what the candidate healthcheck covers
# (scripts/healthcheck.ts runs before traffic switches, see RUNBOOK.md).
# ---------------------------------------------------------------------------
FROM nginx:1.30-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
