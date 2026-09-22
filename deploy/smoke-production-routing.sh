#!/usr/bin/env bash
# Exercise the public Nginx boundary after a production deployment.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  printf 'usage: %s https://host [https://host ...]\n' "$0" >&2
  exit 2
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

for base_url in "$@"; do
  if [[ ! "${base_url}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]]; then
    printf 'invalid production smoke URL: %s\n' "${base_url}" >&2
    exit 2
  fi
  origin="${base_url%/}"
  host="${origin#https://}"
  headers_path="${tmp_dir}/${host}.headers"
  page_path="${tmp_dir}/${host}.html"
  api_path="${tmp_dir}/${host}.api.json"

  page_status="$(
    curl --silent --show-error --location --max-time 30 --retry 3 \
      --dump-header "${headers_path}" --output "${page_path}" \
      --write-out '%{http_code}' "${origin}/"
  )"
  if [ "${page_status}" != "200" ]; then
    printf '%s homepage returned HTTP %s\n' "${origin}" "${page_status}" >&2
    exit 1
  fi
  if ! grep -Eiq '^content-type:[[:space:]]*text/html' "${headers_path}"; then
    printf '%s homepage did not return HTML\n' "${origin}" >&2
    exit 1
  fi
  if grep -Fq 'route_not_migrated' "${page_path}"; then
    printf '%s homepage was routed to the Go fallback\n' "${origin}" >&2
    exit 1
  fi

  asset_path="$(
    grep -Eo '/_next/static/[^"[:space:]<>]+\.(js|css)' "${page_path}" \
      | head -n 1 || true
  )"
  if [ -z "${asset_path}" ]; then
    printf '%s homepage did not reference a Next.js static asset\n' \
      "${origin}" >&2
    exit 1
  fi
  curl --fail --silent --show-error --max-time 30 --retry 3 \
    --output /dev/null "${origin}${asset_path}"

  api_status="$(
    curl --silent --show-error --max-time 30 --retry 3 \
      --output "${api_path}" --write-out '%{http_code}' \
      "${origin}/api/system-settings/site-branding"
  )"
  if [ "${api_status}" != "200" ]; then
    printf '%s API smoke returned HTTP %s\n' "${origin}" "${api_status}" >&2
    exit 1
  fi
  if grep -Fq 'route_not_migrated' "${api_path}"; then
    printf '%s API smoke reached the Go fallback route\n' "${origin}" >&2
    exit 1
  fi

  nginx_status="$(
    curl --silent --show-error --max-time 15 --output /dev/null \
      --write-out '%{http_code}' "${origin}/nginx-health"
  )"
  backend_status="$(
    curl --silent --show-error --max-time 15 --output /dev/null \
      --write-out '%{http_code}' "${origin}/readyz"
  )"
  if [ "${nginx_status}" != "204" ] || [ "${backend_status}" != "200" ]; then
    printf '%s health smoke failed: nginx=%s backend=%s\n' \
      "${origin}" "${nginx_status}" "${backend_status}" >&2
    exit 1
  fi

  printf '%s routing smoke passed.\n' "${origin}"
done
