#!/usr/bin/env bash
# Verify that public pages remain on Next.js while application endpoints use Go.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_path="${script_dir}/conf.d/fluxmedia.conf"

fail() {
  printf 'Nginx routing contract failed: %s\n' "$1" >&2
  exit 1
}

require_count() {
  expected="$1"
  text="$2"
  actual="$(grep -Fc -- "${text}" "${config_path}" || true)"
  if [ "${actual}" -ne "${expected}" ]; then
    fail "expected ${expected} occurrence(s) of '${text}', found ${actual}"
  fi
}

require_location_upstream() {
  location_header="$1"
  upstream="$2"
  expected_count="$3"
  actual_count="$({
    awk -v header="${location_header}" -v upstream="${upstream}" '
      $0 == "    " header " {" {
        in_location = 1
        matched = 0
        next
      }
      in_location && index($0, "proxy_pass http://" upstream ";") > 0 {
        matched = 1
      }
      in_location && $0 == "    }" {
        if (matched) count++
        in_location = 0
      }
      END { print count + 0 }
    ' "${config_path}"
  })"
  if [ "${actual_count}" -ne "${expected_count}" ]; then
    fail "location '${location_header}' must use ${upstream} in both HTTPS servers"
  fi
}

require_count 1 'upstream fluxmedia_web {'
require_count 1 'upstream fluxmedia_backend {'
require_count 0 'fluxmedia_gateway'

require_location_upstream 'location /' 'fluxmedia_web' 2
require_location_upstream 'location /_next/static/' 'fluxmedia_web' 2
require_location_upstream 'location ^~ /api/go/' 'fluxmedia_backend' 2
require_count 2 'rewrite ^/api/go(/.*)$ $1 break;'
require_location_upstream \
  'location ~ ^/(?:api/)?(?:v1|v1beta)/' 'fluxmedia_backend' 2
require_location_upstream \
  'location ~ ^/api/(?:images|videos|editable-file)/' \
  'fluxmedia_backend' 2
require_location_upstream \
  'location ~ ^/(?:api(?:/|$)|moderate$|r/|healthz$|readyz$|health$|ready$)' \
  'fluxmedia_backend' 2

# The two streaming locations in each HTTPS server must retain their long-lived
# request settings after the upstream split.
require_count 4 'proxy_buffering off;'
require_count 4 'proxy_request_buffering off;'
require_count 4 'proxy_read_timeout 3600s;'
require_count 4 'proxy_send_timeout 3600s;'

printf 'Nginx routing contract passed.\n'
