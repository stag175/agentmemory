#!/bin/sh
# agentmemory deployment entrypoint.
#
# Runs as root so it can:
#   1. Overwrite the npm-bundled iii-config.yaml (which binds 127.0.0.1
#      and uses relative ./data paths) with a deploy-tuned version that
#      binds 0.0.0.0 and uses absolute /data paths.
#   2. chown the platform-mounted /data volume to the runtime user
#      (managed platforms mount volumes root-owned 755 by default).
#   3. Refuse to start without AGENTMEMORY_SECRET because the REST API
#      is bound to a public platform proxy.
#
# Then it execs the agentmemory CLI under gosu as the unprivileged
# `node` user.

set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
RUN_AS="node:node"
III_CONFIG="/opt/agentmemory/node_modules/@agentmemory/agentmemory/dist/iii-config.yaml"

if [ -z "${AGENTMEMORY_SECRET:-}" ]; then
  echo "agentmemory: AGENTMEMORY_SECRET is required for this public deployment template." >&2
  echo "Set a strong random value in the platform secret store before deploying." >&2
  exit 1
fi

export AGENTMEMORY_SECRET

mkdir -p "$DATA_DIR"
chown -R "$RUN_AS" "$DATA_DIR"

cat > "$III_CONFIG" <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://localhost:3113"
          - "http://127.0.0.1:3111"
          - "http://127.0.0.1:3113"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 0.1
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: false
EOF
chown "$RUN_AS" "$III_CONFIG"

# The viewer's default 127.0.0.1 bind is unreachable through fly proxy,
# which enters the machine via fly-local-6pn (IPv6). Opt into a
# non-loopback bind ONLY when we're actually inside Fly (detected via
# Fly's runtime variables). A plain `docker run` of this image will not
# see these variables and will keep the safe-by-default loopback bind,
# so it can't silently expose the viewer's bearer-authorized proxy to
# the LAN. VIEWER_ALLOWED_HOSTS is preseeded to the Host headers that
# `fly proxy 3113:3113` actually produces on the operator's laptop.
if [ -n "${FLY_APP_NAME:-}" ] || [ -n "${FLY_ALLOC_ID:-}" ]; then
  : "${AGENTMEMORY_VIEWER_HOST:=::}"
  : "${VIEWER_ALLOWED_HOSTS:=localhost:3113,127.0.0.1:3113,[::1]:3113}"
  export AGENTMEMORY_VIEWER_HOST VIEWER_ALLOWED_HOSTS
fi

exec gosu "$RUN_AS" agentmemory "$@"
