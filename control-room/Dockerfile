# syntax=docker/dockerfile:1
# mikluha-control-room (ART-363). Build context: control-room/
#   docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) control-room
# Static files only: the build reads no environment and no credential, and the runtime is Nginx.

FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY . .
ARG SOURCE_COMMIT
ENV NEXT_TELEMETRY_DISABLED=1
# `build` ends with scripts/check-bundle.mjs: a credential-like string in out/ fails the image.
RUN pnpm run build \
    && echo "$SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{40}$' \
    && printf '{"schema":1,"service":"mikluha-control-room","sourceCommit":"%s"}\n' "$SOURCE_COMMIT" > out/identity.json

FROM nginx:1.30-alpine AS runtime
ENV ADMIN_API_UPSTREAM=mikluha-admin-api:3000
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/identity.json >/dev/null 2>&1 || exit 1
