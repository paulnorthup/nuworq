# Build from the repository root:  docker build -f deploy/Dockerfile -t trellis .
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web

RUN addgroup -S trellis && adduser -S -G trellis -H trellis \
 && mkdir -p /data && chown trellis:trellis /data

USER trellis
ENV NODE_ENV=production TRELLIS_DB=/data/trellis.db
VOLUME /data
EXPOSE 4747

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4747/api/health >/dev/null || exit 1

# Listening on 0.0.0.0 inside the container turns login on automatically.
# Create a human token first:  docker compose run --rm trellis node bin/trellis.js token create <you> --role human
CMD ["node", "bin/trellis.js", "serve", "--host", "0.0.0.0", "--db", "/data/trellis.db"]
