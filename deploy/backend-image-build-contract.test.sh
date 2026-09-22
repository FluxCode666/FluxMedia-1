#!/usr/bin/env bash
# Keep the production backend build free of the two largest avoidable costs:
# recursively copying /app for ownership and exporting a full GHA cache.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
dockerfile_path="${repository_root}/Dockerfile.api-gateway"
workflow_path="${repository_root}/.github/workflows/deploy-production.yml"

require_text() {
  file_path="$1"
  expected="$2"
  if ! grep -Fq -- "${expected}" "${file_path}"; then
    printf 'backend build contract missing: %s\nfile: %s\n' \
      "${expected}" "${file_path}" >&2
    exit 1
  fi
}

forbid_text() {
  file_path="$1"
  forbidden="$2"
  if grep -Fq -- "${forbidden}" "${file_path}"; then
    printf 'backend build contract contains slow path: %s\nfile: %s\n' \
      "${forbidden}" "${file_path}" >&2
    exit 1
  fi
}

require_text "${dockerfile_path}" 'RUN go mod download'
require_text \
  "${dockerfile_path}" \
  'COPY --chown=backend:backend --from=migration-runtime /app ./'
require_text \
  "${dockerfile_path}" \
  'COPY --chown=backend:backend --from=go-builder /out/backend /backend'
require_text \
  "${dockerfile_path}" \
  'COPY --chown=backend:backend --chmod=0755 services/api-gateway/backend-entrypoint.sh /usr/local/bin/backend-entrypoint'
forbid_text "${dockerfile_path}" 'chown -R backend:backend /app'

backend_build_block="$(
  sed -n \
    '/- name: Build and push backend image/,/- name: Build and push script runtime image/p' \
    "${workflow_path}"
)"
if [ -z "${backend_build_block}" ]; then
  printf 'could not locate backend image build step\n' >&2
  exit 1
fi
printf '%s\n' "${backend_build_block}" \
  | grep -Fq 'type=registry,ref=${{ steps.meta.outputs.backend_image }}:latest'
printf '%s\n' "${backend_build_block}" \
  | grep -Fq 'cache-to: type=inline'
if printf '%s\n' "${backend_build_block}" \
  | grep -Fq 'cache-to: type=gha,mode=max'; then
  printf 'backend image build must not export a full GHA cache\n' >&2
  exit 1
fi

printf 'Backend image build performance contract passed.\n'
