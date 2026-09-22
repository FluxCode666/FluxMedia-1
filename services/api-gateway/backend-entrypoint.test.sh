#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
entrypoint="${script_dir}/backend-entrypoint.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT HUP INT TERM

stub="${temp_dir}/stub"
cat >"${stub}" <<'STUB'
#!/bin/sh
printf 'command=%s\n' "$0"
printf 'args=%s\n' "$*"
STUB
chmod 0755 "${stub}"

default_output="$(
  FLUXMEDIA_BACKEND_ROOT="${temp_dir}" GO_BACKEND_EXECUTABLE="${stub}" \
    sh "${entrypoint}"
)"
printf '%s\n' "${default_output}" | grep -Fqx "command=${stub}"
printf '%s\n' "${default_output}" | grep -Fqx 'args='

explicit_output="$(
  FLUXMEDIA_BACKEND_ROOT="${temp_dir}" \
    GO_BACKEND_EXECUTABLE="${temp_dir}/missing" \
    sh "${entrypoint}" "${stub}" release-gate preflight-early
)"
printf '%s\n' "${explicit_output}" | grep -Fqx "command=${stub}"
printf '%s\n' "${explicit_output}" \
  | grep -Fqx 'args=release-gate preflight-early'

printf 'backend entrypoint tests passed\n'
