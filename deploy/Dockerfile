# Build from the repository root:  docker build -f deploy/Dockerfile -t nuworq .
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web

RUN addgroup -S nuworq && adduser -S -G nuworq -H nuworq \
 && mkdir -p /data && chown nuworq:nuworq /data

USER nuworq
ENV NODE_ENV=production NUWORQ_DB=/data/nuworq.db
VOLUME /data
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4747/api/health >/dev/null || exit 1

# Listening on 0.0.0.0 inside the container turns login on automatically.
# Create a human token first:  docker compose run --rm nuworq node bin/nuworq.js token create <you> --role human
CMD ["node", "bin/nuworq.js", "serve", "--host", "0.0.0.0", "--db", "/data/nuworq.db"]
