# syntax=docker/dockerfile:1
# Synthetic image for the Coolify digest PoC (ART-360). No secrets, no volumes, no database.
FROM node:22-alpine
ARG SOURCE_COMMIT
# Coolify sets SOURCE_COMMIT=HEAD in the container at runtime, overriding an image ENV, so the commit
# is written to a file at build time, as commerce/Dockerfile does.
ENV NODE_ENV=production
WORKDIR /app
RUN test -n "$SOURCE_COMMIT" && printf '%s' "$SOURCE_COMMIT" > /app/commit
COPY server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
