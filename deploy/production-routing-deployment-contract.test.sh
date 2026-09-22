#!/usr/bin/env bash
# Lock the production workflow to the split Web/Go Nginx topology.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workflow_path="${script_dir}/../.github/workflows/deploy-production.yml"

require_text() {
  expected="$1"
  if ! grep -Fq -- "${expected}" "${workflow_path}"; then
    printf 'production routing deployment contract missing: %s\n' \
      "${expected}" >&2
    exit 1
  fi
}

require_text 'deploy/nginx/conf.d/fluxmedia.conf \'
require_text 'deploy/smoke-production-routing.sh \'
require_text 'install_nginx_configuration()'
require_text 'nginx -t'
require_text 'systemctl reload nginx'
require_text 'cron_secret="$(read_env_value CRON_SECRET)"'
require_text '-e GO_BACKEND_URL=http://backend:8080 backend \'
require_text 'bash ./smoke-production-routing.sh \'
require_text 'https://media.flux-code.cc https://media.fluxhall.cc'

nginx_install_line="$(
  grep -nF 'install_nginx_configuration' "${workflow_path}" \
    | tail -n 1 | cut -d: -f1
)"
cron_gate_line="$(
  grep -nF 'cron_secret="$(read_env_value CRON_SECRET)"' "${workflow_path}" \
    | cut -d: -f1
)"
stop_line="$(
  grep -nF 'docker compose stop --timeout 60 web backend script-runtime media-processing' \
    "${workflow_path}" | cut -d: -f1
)"
smoke_line="$(
  grep -nF 'bash ./smoke-production-routing.sh' "${workflow_path}" \
    | tail -n 1 | cut -d: -f1
)"
success_line="$(
  grep -nF "printf 'deployment_completed=true\\n'" "${workflow_path}" \
    | cut -d: -f1
)"

if [ -z "${nginx_install_line}" ] || [ -z "${cron_gate_line}" ] \
  || [ -z "${stop_line}" ] || [ -z "${smoke_line}" ] \
  || [ -z "${success_line}" ]; then
  printf 'could not locate production routing deployment boundaries\n' >&2
  exit 1
fi
if [ "${nginx_install_line}" -ge "${stop_line}" ] \
  || [ "${cron_gate_line}" -ge "${stop_line}" ]; then
  printf 'Nginx and CRON_SECRET gates must run before production services stop\n' >&2
  exit 1
fi
if [ "${smoke_line}" -ge "${success_line}" ]; then
  printf 'public routing smoke must pass before deployment success\n' >&2
  exit 1
fi

printf 'Production routing deployment contract passed.\n'
