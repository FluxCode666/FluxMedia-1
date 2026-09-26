#!/usr/bin/env bash
# Regression tests for the one-command system update configuration script.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="${script_dir}/configure-system-updates.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "${test_dir}"' EXIT

fake_bin="${test_dir}/bin"
mkdir -p "${fake_bin}"
cat >"${fake_bin}/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
printf '%s' "${FAKE_CURL_STATUS:-200}"
FAKE_CURL
chmod +x "${fake_bin}/curl"

cat >"${fake_bin}/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${DOCKER_LOG}"
FAKE_DOCKER
chmod +x "${fake_bin}/docker"

env_file="${test_dir}/.env"
cat >"${env_file}" <<'ENV'
DATABASE_URL=postgresql://db/flux
FLUXMEDIA_GITHUB_ACTIONS_TOKEN=old-token
FLUXMEDIA_GITHUB_ACTIONS_TOKEN=stale-token
ENV

secret_token="github_pat_test_token_123"
output="$({
  printf '%s\n' "${secret_token}" \
    | PATH="${fake_bin}:${PATH}" bash "${script_path}" \
      --env-file "${env_file}" --token-stdin --no-recreate
} 2>&1)"

if printf '%s' "${output}" | grep -Fq -- "${secret_token}"; then
  printf '用例失败：配置命令输出了 token。\n' >&2
  exit 1
fi
if [ "$(grep -c '^FLUXMEDIA_GITHUB_ACTIONS_TOKEN=' "${env_file}")" -ne 1 ]; then
  printf '用例失败：环境文件存在重复 token 配置。\n' >&2
  exit 1
fi
if ! grep -Fxq "FLUXMEDIA_GITHUB_ACTIONS_TOKEN=${secret_token}" "${env_file}"; then
  printf '用例失败：环境文件未写入新 token。\n' >&2
  exit 1
fi
if ! grep -Fxq 'DATABASE_URL=postgresql://db/flux' "${env_file}"; then
  printf '用例失败：环境文件其他配置被破坏。\n' >&2
  exit 1
fi
if [ "$(stat -f '%Lp' "${env_file}" 2>/dev/null || stat -c '%a' "${env_file}")" != "600" ]; then
  printf '用例失败：环境文件权限不是 600。\n' >&2
  exit 1
fi

printf 'services: {}\n' >"${test_dir}/docker-compose.yml"
docker_log="${test_dir}/docker.log"
output="$(
  printf '%s\n' "${secret_token}" \
    | DOCKER_LOG="${docker_log}" DEPLOY_PATH="${test_dir}" \
      PATH="${fake_bin}:${PATH}" bash "${script_path}" \
        --env-file "${env_file}" --token-stdin
)"
if printf '%s' "${output}" | grep -Fq -- "${secret_token}"; then
  printf '用例失败：重建命令输出了 token。\n' >&2
  exit 1
fi
if [ "$(wc -l <"${docker_log}" | tr -d ' ')" -ne 2 ] \
  || ! grep -Fq -- 'config --quiet' "${docker_log}" \
  || ! grep -Fq -- 'up -d --no-build --force-recreate app' "${docker_log}"; then
  printf '用例失败：未校验 Compose 或未重建 app。\n' >&2
  exit 1
fi

if printf '%s\n' 'github_pat_rejected_token' \
  | FAKE_CURL_STATUS=403 PATH="${fake_bin}:${PATH}" bash "${script_path}" \
      --env-file "${env_file}" --token-stdin --no-recreate >/dev/null 2>&1; then
  printf '用例失败：未拒绝 GitHub API 返回 403 的 token。\n' >&2
  exit 1
fi
if ! grep -Fxq "FLUXMEDIA_GITHUB_ACTIONS_TOKEN=${secret_token}" "${env_file}"; then
  printf '用例失败：GitHub 校验失败后修改了环境文件。\n' >&2
  exit 1
fi

invalid_env="${test_dir}/invalid.env"
printf 'DATABASE_URL=postgresql://db/flux\n' >"${invalid_env}"
if printf '%s\n' 'invalid token' \
  | PATH="${fake_bin}:${PATH}" bash "${script_path}" \
      --env-file "${invalid_env}" --token-stdin --no-recreate >/dev/null 2>&1; then
  printf '用例失败：未拒绝包含空格的 token。\n' >&2
  exit 1
fi
if grep -q '^FLUXMEDIA_GITHUB_ACTIONS_TOKEN=' "${invalid_env}"; then
  printf '用例失败：无效 token 不应写入环境文件。\n' >&2
  exit 1
fi

printf '系统更新一键配置命令测试通过。\n'
