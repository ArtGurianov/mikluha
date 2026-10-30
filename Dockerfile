# syntax=docker/dockerfile:1
# The SSR site (ADR v2.3 §2, §8; TOUR-60): `next start` reading Commerce's public projection on every
# request. Built by CI for an exact commit and released to a Coolify Docker Image application by digest
# (.github/workflows/site-ssr-release.yml), never built on the VPS.
#
#   docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) .
#
# The build reads no production data: every page is rendered on request. What the image carries from
# content/ provides site settings; runtime legal text comes from Commerce. The build-baked
# /release.json served by /identity identifies code independently of published legal text.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
ARG DEPLOY_ENV=production
ARG SITE_URL
ARG SOURCE_COMMIT
ARG NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY
ENV DEPLOY_ENV=$DEPLOY_ENV \
    SITE_URL=$SITE_URL \
    SOURCE_COMMIT=$SOURCE_COMMIT \
    NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY=$NEXT_PUBLIC_YANDEX_SMARTCAPTCHA_SITE_KEY \
    NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm run build:production

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/.site-build/content.json ./.site-build/content.json
RUN chmod 0444 ./public/release.json ./.site-build/content.json
USER node
# Coolify's "Ports Exposes" must say 3000 (its default 80 answers 502; ART-360 PoC).
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/release.json >/dev/null 2>&1 || exit 1
# Node 22 resolves require() of Next's @swc/helpers through the `module-sync` export condition to
# ESM files the standalone trace does not copy; without require(esm) it takes the traced CJS ones.
CMD ["node", "--no-experimental-require-module", "server.js"]
