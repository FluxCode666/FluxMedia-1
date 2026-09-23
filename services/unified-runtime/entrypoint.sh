#!/bin/sh
set -eu

# Compose's `env_file.format: raw` keeps `$` byte-for-byte intact, which is
# required for passwords and connection strings. It also keeps dotenv's
# optional outer quotes, though. Normalize the handful of credentials that
# are intentionally consumed by the application so both standard dotenv and
# raw dotenv files produce the same runtime value.
normalize_raw_value() {
  value="$1"
  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac
  printf '%s' "$value"
}

normalize_raw_credentials() {
  if [ "${DATABASE_URL+x}" = x ]; then
    DATABASE_URL="$(normalize_raw_value "$DATABASE_URL")"
    export DATABASE_URL
  fi
  if [ "${BETTER_AUTH_SECRET+x}" = x ]; then
    BETTER_AUTH_SECRET="$(normalize_raw_value "$BETTER_AUTH_SECRET")"
    export BETTER_AUTH_SECRET
  fi
  if [ "${CRON_SECRET+x}" = x ]; then
    CRON_SECRET="$(normalize_raw_value "$CRON_SECRET")"
    export CRON_SECRET
  fi
  if [ "${REDIS_PASSWORD+x}" = x ]; then
    REDIS_PASSWORD="$(normalize_raw_value "$REDIS_PASSWORD")"
    export REDIS_PASSWORD
  fi
  if [ "${GO_SCRIPT_RUNTIME_TOKEN+x}" = x ]; then
    GO_SCRIPT_RUNTIME_TOKEN="$(normalize_raw_value "$GO_SCRIPT_RUNTIME_TOKEN")"
    export GO_SCRIPT_RUNTIME_TOKEN
  fi
  if [ "${GO_MEDIA_PROCESSING_TOKEN+x}" = x ]; then
    GO_MEDIA_PROCESSING_TOKEN="$(normalize_raw_value "$GO_MEDIA_PROCESSING_TOKEN")"
    export GO_MEDIA_PROCESSING_TOKEN
  fi
  if [ "${SCRIPT_RUNTIME_TOKEN+x}" = x ]; then
    SCRIPT_RUNTIME_TOKEN="$(normalize_raw_value "$SCRIPT_RUNTIME_TOKEN")"
    export SCRIPT_RUNTIME_TOKEN
  fi
  if [ "${MEDIA_PROCESSING_TOKEN+x}" = x ]; then
    MEDIA_PROCESSING_TOKEN="$(normalize_raw_value "$MEDIA_PROCESSING_TOKEN")"
    export MEDIA_PROCESSING_TOKEN
  fi
  if [ "${FLUXMEDIA_SUPER_ADMIN_EMAIL+x}" = x ]; then
    FLUXMEDIA_SUPER_ADMIN_EMAIL="$(normalize_raw_value "$FLUXMEDIA_SUPER_ADMIN_EMAIL")"
    export FLUXMEDIA_SUPER_ADMIN_EMAIL
  fi
  if [ "${FLUXMEDIA_SUPER_ADMIN_PASSWORD+x}" = x ]; then
    FLUXMEDIA_SUPER_ADMIN_PASSWORD="$(normalize_raw_value "$FLUXMEDIA_SUPER_ADMIN_PASSWORD")"
    export FLUXMEDIA_SUPER_ADMIN_PASSWORD
  fi
}

normalize_raw_credentials

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

exec "${UNIFIED_NODE_EXECUTABLE:-node}" \
  "${UNIFIED_SUPERVISOR_PATH:-/app/services/unified-runtime/supervisor.mjs}"
