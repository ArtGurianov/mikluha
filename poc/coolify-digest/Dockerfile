# syntax=docker/dockerfile:1
# Synthetic image for the Coolify digest PoC (ART-360). No secrets, no volumes, no database.
FROM node:22-alpine
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=$SOURCE_COMMIT NODE_ENV=production
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
