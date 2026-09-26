#!/usr/bin/env bash
# Configure the in-site super-admin production update capability.
# The token is read from the terminal (or stdin), never from a command-line argument.

set -euo pipefail

readonly GITHUB_REPOSITORY="FluxCode666/FluxMedia-1"
readonly GITHUB_API="https://api.github.com"
readonly GITHUB_API_VERSION="2022-11-28"
readonly TOKEN_KEY="FLUXMEDIA_GITHUB_ACTIONS_TOKEN"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy_path="${DEPLOY_PATH:-${script_dir}}"
env_file="${ENV_FILE:-${deploy_path}/.env}"
read_token_from_stdin="false"
recreate_app="true"

usage() {
  cat <<'USAGE'
用法：
  bash configure-system-updates.sh [选项]

选项：
  --env-file PATH    指定生产 dotenv 文件，默认 <脚本目录>/.env
  --token-stdin      从 stdin 读取 token；默认在终端隐藏输入
  --no-recreate      只写入并校验配置，不重建 app 容器
  -h, --help         显示帮助

示例：
  sudo bash /root/fluxmedia/configure-system-updates.sh
  printf '%s\n' "$GITHUB_TOKEN" | sudo bash /root/fluxmedia/configure-system-updates.sh --token-stdin
USAGE
}

fail() {
  printf '系统更新配置失败：%s\n' "$1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || fail "--env-file 缺少路径"
      env_file="$2"
      shift 2
      ;;
    --token-stdin)
      read_token_from_stdin="true"
      shift
      ;;
    --no-recreate)
      recreate_app="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[ -f "${env_file}" ] || fail "找不到生产环境文件：${env_file}"
[ ! -L "${env_file}" ] || fail "拒绝写入符号链接环境文件：${env_file}"
[ -r "${env_file}" ] || fail "环境文件不可读：${env_file}"
[ -w "${env_file}" ] || fail "环境文件不可写，请使用 sudo：${env_file}"
command -v curl >/dev/null 2>&1 || fail "服务器缺少 curl"

if [ "${read_token_from_stdin}" = "true" ]; then
  IFS= read -r token || true
else
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    fail "非交互模式请使用 --token-stdin；不要把 token 放在命令行参数中"
  fi
  printf '请输入 GitHub fine-grained token（输入不会显示）：'
  IFS= read -r -s token
  printf '\n'
fi

[ -n "${token:-}" ] || fail "token 不能为空"
if [[ "${token}" =~ [[:space:]\\\"\'\#=] ]]; then
  fail "token 包含 dotenv 不安全字符"
fi

curl_config="$(mktemp)"
curl_error="$(mktemp)"
env_tmp="$(mktemp "${env_file}.tmp.XXXXXX")"
cleanup() {
  rm -f "${curl_config}" "${curl_error}" "${env_tmp}"
}
trap cleanup EXIT
chmod 600 "${curl_config}" "${curl_error}" "${env_tmp}"

# Keep the secret in a root-readable temporary curl config instead of exposing it
# in the process list as a command-line header.
printf '%s\n' \
  'header = "Accept: application/vnd.github+json"' \
  "header = \"Authorization: Bearer ${token}\"" \
  "header = \"X-GitHub-Api-Version: ${GITHUB_API_VERSION}\"" \
  >"${curl_config}"

workflow_url="${GITHUB_API}/repos/${GITHUB_REPOSITORY}/actions/workflows/deploy-production.yml"
http_status="$(
  curl --config "${curl_config}" \
    --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --connect-timeout 10 --max-time 20 \
    "${workflow_url}" 2>"${curl_error}" || true
)"
if [ "${http_status}" != "200" ]; then
  fail "GitHub token 校验失败（workflow API 返回 HTTP ${http_status:-unknown}）；请确认仓库范围和 Actions 权限"
fi

# Replace every existing copy so a stale duplicate dotenv key cannot override the new token.
awk -v key="${TOKEN_KEY}" -v value="${token}" '
  $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
    if (!replaced) print key "=" value
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) print key "=" value
  }
' "${env_file}" >"${env_tmp}"

# Keep the existing owner while enforcing a private environment file and atomic replacement.
chown --reference="${env_file}" "${env_tmp}" 2>/dev/null || true
chmod 600 "${env_tmp}"
mv -f "${env_tmp}" "${env_file}"

if [ "${recreate_app}" = "false" ]; then
  printf '已写入并校验 %s；按 --no-recreate 跳过 app 重建。\n' "${TOKEN_KEY}"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "服务器缺少 docker；配置已写入，请安装 Docker 后重建 app"
[ -f "${deploy_path}/docker-compose.yml" ] \
  || fail "找不到 Compose 文件：${deploy_path}/docker-compose.yml；配置已写入"

docker compose \
  --project-directory "${deploy_path}" \
  --env-file "${env_file}" \
  -f "${deploy_path}/docker-compose.yml" \
  --project-name fluxmedia \
  config --quiet

docker compose \
  --project-directory "${deploy_path}" \
  --env-file "${env_file}" \
  -f "${deploy_path}/docker-compose.yml" \
  --project-name fluxmedia \
  up -d --no-build --force-recreate app

printf '系统更新已配置；app 容器已重建。\n'
