#!/usr/bin/env bash
# Lock the production workflow to one app container with split Web/Go Nginx
# routing and a recoverable first transition from the legacy topology.

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

forbid_text() {
  forbidden="$1"
  if grep -Fq -- "${forbidden}" "${workflow_path}"; then
    printf 'production routing deployment contract contains unsafe text: %s\n' \
      "${forbidden}" >&2
    exit 1
  fi
}

require_text 'deploy/nginx/conf.d/fluxmedia.conf \'
require_text 'deploy/smoke-production-routing.sh \'
require_text 'replace_nginx_configuration_atomically()'
require_text 'install_nginx_configuration()'
require_text 'restore_previous_nginx_configuration()'
require_text 'target_tmp="${target_directory}/.${target_name}.tmp.$$"'
require_text 'chown --reference="${target_path}" "${target_tmp}"'
require_text 'chmod --reference="${target_path}" "${target_tmp}"'
require_text 'mv -f "${target_tmp}" "${target_path}"'
require_text 'fluxmedia.conf "${nginx_target}"'
require_text '"${nginx_backup_path}" "${nginx_target}"'
require_text '"${attempt_nginx}" /etc/nginx/conf.d/fluxmedia.conf'
forbid_text 'install -m 644 fluxmedia.conf "${nginx_target}"'
forbid_text 'install -m 644 "${nginx_backup_path}" "${nginx_target}"'
forbid_text 'install -m 644 "${attempt_nginx}"'
require_text 'nginx -t'
require_text 'systemctl reload nginx'
require_text 'cron_secret="$(read_env_value CRON_SECRET)"'
require_text 'candidate_compose pull app'
require_text 'previous_compose stop --timeout 60 "${previous_services[@]}"'
require_text 'active_compose stop --timeout 30 app'
require_text 'active_compose up -d --remove-orphans app'
require_text 'app_container_id="$(active_compose ps -q app)"'
require_text 'if [ "${app_health_status}" = "healthy" ]; then'
require_text 'bash ./smoke-production-routing.sh \'
require_text 'https://media.flux-code.cc https://media.fluxhall.cc'
require_text 'docker-compose.next.yml'
require_text 'install -m 640 docker-compose.yml "${previous_compose_path}"'
require_text 'activate_compose_file "${previous_compose_path}"'
require_text 'activate_compose_file docker-compose.next.yml'
require_text '--project-directory "${deploy_path}"'
require_text '--env-file "${deploy_path}/.env"'
require_text 'if ! restore_previous_nginx_configuration; then'
require_text '&& [ "${previous_release_available}" != "true" ]; then'
require_text 'migration_marker="${release_state_dir}/migration-in-progress.env"'
require_text 'deployment_attempt="${release_state_dir}/deployment-attempt.env"'
require_text 'maintenance_resume=true'
require_text 'write_migration_marker'
require_text 'rm -f "${migration_marker}" "${deployment_attempt}"'
require_text 'migration_started=true'
require_text 'require_env_value()'
require_text '生产 .env 的 BIND_HOST/WEB_PORT/GO_BACKEND_PORT 必须为 127.0.0.1/3000/3001。'
require_text '生产存储目录已有内容但统一应用用户不可写，拒绝迁移。'
require_text 'prepare_video_input_migration_state'

nginx_install_line="$(
  grep -nF 'install_nginx_configuration' "${workflow_path}" \
    | tail -n 1 | cut -d: -f1
)"
cron_gate_line="$(
  grep -nF 'cron_secret="$(read_env_value CRON_SECRET)"' "${workflow_path}" \
    | cut -d: -f1
)"
stop_line="$(
  grep -nF 'previous_compose stop --timeout 60 "${previous_services[@]}"' \
    "${workflow_path}" | cut -d: -f1
)"
stop_boundary_line="$(
  grep -nF 'application_stopped=true' "${workflow_path}" | cut -d: -f1
)"
running_gate_line="$(
  grep -nF '&& [ "${previous_application_was_running}" != "true" ]; then' \
    "${workflow_path}" | cut -d: -f1
)"
candidate_promote_line="$(
  grep -nF 'activate_compose_file docker-compose.next.yml' \
    "${workflow_path}" | cut -d: -f1
)"
migration_marker_line="$(
  grep -nF '          write_migration_marker' "${workflow_path}" \
    | tail -n 1 | cut -d: -f1
)"
migration_started_line="$(
  grep -nF 'migration_started=true' "${workflow_path}" \
    | tail -n 1 | cut -d: -f1
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
  || [ -z "${stop_line}" ] || [ -z "${stop_boundary_line}" ] \
  || [ -z "${running_gate_line}" ] || [ -z "${migration_marker_line}" ] \
  || [ -z "${candidate_promote_line}" ] \
  || [ -z "${migration_started_line}" ] || [ -z "${smoke_line}" ] \
  || [ -z "${success_line}" ]; then
  printf 'could not locate production routing deployment boundaries\n' >&2
  exit 1
fi
if [ "${nginx_install_line}" -ge "${stop_line}" ] \
  || [ "${cron_gate_line}" -ge "${stop_line}" ]; then
  printf 'Nginx and CRON_SECRET gates must run before production services stop\n' >&2
  exit 1
fi
if [ "${running_gate_line}" -ge "${stop_boundary_line}" ] \
  || [ "${stop_boundary_line}" -ge "${stop_line}" ]; then
  printf 'running-state gate and recoverable stop boundary must precede stop\n' >&2
  exit 1
fi
if [ "${stop_line}" -ge "${migration_marker_line}" ] \
  || [ "${migration_marker_line}" -ge "${migration_started_line}" ] \
  || [ "${migration_started_line}" -ge "${candidate_promote_line}" ]; then
  printf 'persistent boundary must precede candidate promotion after legacy stop\n' >&2
  exit 1
fi
if [ "${smoke_line}" -ge "${success_line}" ]; then
  printf 'public routing smoke must pass before deployment success\n' >&2
  exit 1
fi

printf 'Production routing deployment contract passed.\n'
