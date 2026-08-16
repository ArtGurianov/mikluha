# syntax=docker/dockerfile:1
#
# GitHub OAuth token-exchange broker for the Sveltia CMS admin panel. Zero
# dependencies, no build step — see server.js for why this exists.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./

ENV NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
