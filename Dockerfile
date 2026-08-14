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
# Stage 2: clean production build (PRD section 34.2 pipeline)
#
# Sanity credentials are passed as build ARGs — they exist only in this
# ephemeral build stage/layer and are never copied into the runtime image.
# Omit them entirely to build against the committed lib/cms/fixtures mock
# content instead of a live Sanity dataset.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

ARG SANITY_PROJECT_ID
ARG SANITY_DATASET
ARG SANITY_API_TOKEN
ARG SANITY_API_VERSION=2025-01-01
ARG DEPLOY_ENV=production

ENV SANITY_PROJECT_ID=$SANITY_PROJECT_ID \
    SANITY_DATASET=$SANITY_DATASET \
    SANITY_API_TOKEN=$SANITY_API_TOKEN \
    SANITY_API_VERSION=$SANITY_API_VERSION \
    DEPLOY_ENV=$DEPLOY_ENV \
    NEXT_TELEMETRY_DISABLED=1

COPY . .

RUN pnpm run clean \
 && pnpm run sync:cms \
 && pnpm run materialize:assets \
 && pnpm run validate:content \
 && pnpm run build \
 && pnpm run validate:out

# ---------------------------------------------------------------------------
# Stage 3: production runtime — Nginx serving the static /out only.
# No Node.js, no Sanity credentials, no source code.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/out /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
