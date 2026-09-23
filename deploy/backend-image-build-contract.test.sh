#!/usr/bin/env bash
# Keep the unified production image reproducible and free of the largest
# avoidable build costs: duplicate image builds, recursive ownership rewrites,
# and exporting a full GHA cache.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
dockerfile_path="${repository_root}/Dockerfile.unified"
workflow_path="${repository_root}/.github/workflows/deploy-production.yml"
compose_path="${repository_root}/deploy/docker-compose.yml"
dockerignore_path="${repository_root}/.dockerignore"

require_text() {
  file_path="$1"
  expected="$2"
  if ! grep -Fq -- "${expected}" "${file_path}"; then
    printf 'unified image build contract missing: %s\nfile: %s\n' \
      "${expected}" "${file_path}" >&2
    exit 1
  fi
}

forbid_text() {
  file_path="$1"
  forbidden="$2"
  if grep -Fq -- "${forbidden}" "${file_path}"; then
    printf 'unified image build contract contains slow path: %s\nfile: %s\n' \
      "${forbidden}" "${file_path}" >&2
    exit 1
  fi
}

require_text "${dockerfile_path}" '    go mod download'
require_text "${dockerfile_path}" 'node:22-slim@sha256:'
require_text "${dockerfile_path}" 'golang:1.26.6-bookworm@sha256:'
require_text "${dockerfile_path}" 'id=fluxmedia-go-mod,target=/go/pkg/mod'
require_text "${dockerfile_path}" 'id=fluxmedia-go-build,target=/root/.cache/go-build'
require_text "${dockerfile_path}" 'apt-get install --yes --no-install-recommends ca-certificates'
require_text \
  "${dockerfile_path}" \
  'COPY --link --chown=1001:1001 --from=go-builder /out/backend /backend'
require_text "${dockerfile_path}" 'services/unified-runtime/entrypoint.sh'
require_text "${dockerfile_path}" 'COPY --link --chmod=0755 services/unified-runtime/entrypoint.sh /usr/local/bin/fluxmedia-entrypoint'
require_text "${repository_root}/services/unified-runtime/entrypoint.sh" \
  'normalize_raw_credentials'
require_text "${repository_root}/services/unified-runtime/entrypoint.sh" \
  'DATABASE_URL="$(normalize_raw_value "$DATABASE_URL")"'
forbid_text "${dockerfile_path}" 'chown -R fluxmedia:fluxmedia /app;'
require_text "${dockerignore_path}" '.worktrees'
require_text "${dockerignore_path}" '.playwright-cli'

unified_build_block="$(
  sed -n \
    '/- name: Build and push unified application image/,/^  deploy:/p' \
    "${workflow_path}"
)"
if [ -z "${unified_build_block}" ]; then
  printf 'could not locate unified application image build step\n' >&2
  exit 1
fi
printf '%s\n' "${unified_build_block}" | grep -Fq 'file: Dockerfile.unified'
printf '%s\n' "${unified_build_block}" \
  | grep -Fq 'type=registry,ref=${{ steps.meta.outputs.app_image }}:latest'
printf '%s\n' "${unified_build_block}" \
  | grep -Fq 'cache-to: type=inline'
if printf '%s\n' "${unified_build_block}" \
  | grep -Fq 'cache-to: type=gha,mode=max'; then
  printf 'unified image build must not export a full GHA cache\n' >&2
  exit 1
fi

build_action_count="$(grep -Fc 'uses: docker/build-push-action@' "${workflow_path}")"
if [ "${build_action_count}" -ne 1 ]; then
  printf 'production must build and push exactly one application image.\n' >&2
  exit 1
fi

for old_dockerfile in \
  Dockerfile.web \
  Dockerfile.api-gateway \
  Dockerfile.api-upstream-script-runtime \
  Dockerfile.media-processing-runtime; do
  if printf '%s\n' "${unified_build_block}" | grep -Fq "file: ${old_dockerfile}"; then
    printf 'production workflow still builds legacy image: %s\n' \
      "${old_dockerfile}" >&2
    exit 1
  fi
done

require_text "${compose_path}" 'image: ${FLUXMEDIA_APP_IMAGE_REF:?FLUXMEDIA_APP_IMAGE_REF 必填且必须包含 digest}'
require_text "${compose_path}" 'platform: linux/amd64'
require_text "${compose_path}" 'GO_BACKEND_SKIP_MIGRATION: "true"'
require_text "${compose_path}" 'format: raw'
for forbidden_secret_mapping in \
  'DATABASE_URL: ${DATABASE_URL' \
  'BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET' \
  'REDIS_PASSWORD: ${REDIS_PASSWORD' \
  'GO_SCRIPT_RUNTIME_TOKEN: ${GO_SCRIPT_RUNTIME_TOKEN' \
  'GO_MEDIA_PROCESSING_TOKEN: ${GO_MEDIA_PROCESSING_TOKEN' \
  'SCRIPT_RUNTIME_TOKEN: ${GO_SCRIPT_RUNTIME_TOKEN' \
  'MEDIA_PROCESSING_TOKEN: ${GO_MEDIA_PROCESSING_TOKEN'; do
  forbid_text "${compose_path}" "${forbidden_secret_mapping}"
done
compose_service_count="$(
  awk '
    /^services:$/ { in_services = 1; next }
    in_services && /^[^ ]/ { exit }
    in_services && /^  [A-Za-z0-9_-]+:$/ { count += 1 }
    END { print count + 0 }
  ' "${compose_path}"
)"
if [ "${compose_service_count}" -ne 1 ]; then
  printf 'production Compose must define exactly one application service.\n' >&2
  exit 1
fi
require_text "${compose_path}" '  app:'
require_text "${workflow_path}" 'app_ref="${app_image}@${app_digest}"'
require_text "${workflow_path}" 'set_env_value FLUXMEDIA_APP_IMAGE_REF "${app_ref}"'
require_text "${workflow_path}" 'if [ "${resolved_image}" != "${app_ref}" ]; then'
require_text "${workflow_path}" 'FLUXMEDIA_APP_IMAGE_REF="${app_ref}"'
require_text "${workflow_path}" 'deployment_attempt="${release_state_dir}/deployment-attempt.env"'
require_text "${workflow_path}" 'recover_interrupted_pre_migration_attempt'
require_text "${workflow_path}" 'activate_compose_file docker-compose.next.yml'
forbid_text \
  "${workflow_path}" \
  '[ "${marker_app_ref}" != "${previous_app_ref}" ]'
require_text \
  "${workflow_path}" \
  '-e GO_BACKEND_SKIP_MIGRATION=false app /backend --migrate </dev/null'
migration_command_count="$(grep -Fc -- \
  '-e GO_BACKEND_SKIP_MIGRATION=false app /backend --migrate </dev/null' \
  "${workflow_path}")"
if [ "${migration_command_count}" -ne 1 ]; then
  printf 'production must contain exactly one explicit database migration command.\n' >&2
  exit 1
fi

attempt_line="$(grep -n '^            write_deployment_attempt$' \
  "${workflow_path}" | cut -d: -f1)"
stop_line="$(grep -n '^          if ! previous_compose stop ' \
  "${workflow_path}" | cut -d: -f1)"
marker_line="$(grep -n '^          write_migration_marker$' \
  "${workflow_path}" | tail -n 1 | cut -d: -f1)"
image_ref_line="$(grep -nF \
  '          set_env_value FLUXMEDIA_APP_IMAGE_REF "${app_ref}"' \
  "${workflow_path}" | cut -d: -f1)"
compose_promotion_line="$(grep -nF \
  '          activate_compose_file docker-compose.next.yml' \
  "${workflow_path}" | cut -d: -f1)"
if [ -z "${attempt_line}" ] || [ -z "${stop_line}" ] \
  || [ -z "${marker_line}" ] || [ -z "${image_ref_line}" ] \
  || [ -z "${compose_promotion_line}" ]; then
  printf 'could not locate crash-consistency deployment boundaries.\n' >&2
  exit 1
fi
if [ "${attempt_line}" -ge "${stop_line}" ]; then
  printf 'deployment attempt ledger must be durable before stopping services.\n' >&2
  exit 1
fi
if [ "${marker_line}" -ge "${image_ref_line}" ] \
  || [ "${image_ref_line}" -ge "${compose_promotion_line}" ]; then
  printf 'migration marker must precede env and atomic Compose promotion.\n' >&2
  exit 1
fi

printf 'Unified application image build performance contract passed.\n'
