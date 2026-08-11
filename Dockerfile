FROM node:24-bookworm AS build

WORKDIR /srv/address/app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gosu python3 python3-pip python3-venv zstd \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 address \
  && useradd --uid 10001 --gid address --home-dir /srv/address --shell /usr/sbin/nologin address

ENV ADDRESS_ROOT=/srv/address \
  ADDRESS_DATA_ROOT=/srv/address/data \
  ADDRESS_SYNC_CACHE_DIR=/srv/address/data/staging \
  STATIC_ROOT=/srv/address/app/dist \
  SYNC_STATE_DIR=/srv/address/runtime/sync-control \
  PYTHON_BIN=/srv/address/venv/bin/python \
  NODE_ENV=production

WORKDIR /srv/address/app
COPY --from=build /srv/address/app/server/sync/requirements.txt /tmp/address-requirements.txt
RUN python3 -m venv /srv/address/venv \
  && /srv/address/venv/bin/pip install --no-cache-dir -r /tmp/address-requirements.txt \
  && rm /tmp/address-requirements.txt
COPY --chown=address:address --from=build /srv/address/app /srv/address/app
RUN mkdir -p /srv/address/data/staging /srv/address/runtime/sync-control \
  && chown -R address:address /srv/address/data /srv/address/runtime

COPY ops/container-entrypoint.sh /usr/local/bin/address-entrypoint
RUN chmod 0755 /usr/local/bin/address-entrypoint

ENTRYPOINT ["address-entrypoint"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/api/server.ts"]
