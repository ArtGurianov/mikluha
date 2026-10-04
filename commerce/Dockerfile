# syntax=docker/dockerfile:1
# mikluha-commerce. Build context: the repository root (it needs content/):
#   docker build -f commerce/Dockerfile --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) .

FROM node:22-alpine AS build
WORKDIR /app/commerce
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
COPY commerce/package.json commerce/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY commerce/tsconfig.json ./
COPY commerce/src ./src
RUN pnpm run build && pnpm prune --prod --ignore-workspace

FROM node:22-alpine AS identity
ARG SOURCE_COMMIT
COPY commerce/scripts/write-build-identity.mjs /tmp/write-build-identity.mjs
RUN node /tmp/write-build-identity.mjs /identity/identity.json "$SOURCE_COMMIT" \
    && chmod 0555 /identity && chmod 0444 /identity/identity.json

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    CONTENT_DIR=/app/content \
    PORT=3000
WORKDIR /app/commerce
COPY --from=build /app/commerce/node_modules ./node_modules
COPY --from=build /app/commerce/dist ./dist
COPY commerce/package.json ./
COPY commerce/migrations ./migrations
COPY content /app/content
COPY --from=identity /identity/identity.json /app/identity/identity.json
RUN chmod 0555 /app/identity && chmod 0444 /app/identity/identity.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/bin/serve.js"]
