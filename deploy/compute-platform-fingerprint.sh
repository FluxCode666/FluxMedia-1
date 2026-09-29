#!/usr/bin/env bash
# 计算统一镜像的平台指纹（64 位十六进制 SHA-256）。
#
# 使用方：.github/workflows/release.yml（写入镜像 release.json 与 Release manifest）。
# 参数：无；在仓库任意位置执行均可。
# 站内更新只替换应用代码（/app 与 /backend），无法改变基础镜像、系统依赖、入口脚本、
# 健康检查、媒体模型以及 Compose/Nginx 拓扑。指纹覆盖这些内容：新版本指纹与运行中
# 镜像不一致时，站内更新会拒绝安装，必须走 Deploy Production 换镜像。
# 新增镜像层面的依赖时，把它放进 Dockerfile.unified 的 platform-fingerprint 标记段，
# 或加入下方 PLATFORM_FILES。

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

readonly PLATFORM_FILES=(
  services/unified-runtime/entrypoint.sh
  services/unified-runtime/boot.mjs
  services/unified-runtime/healthcheck.mjs
  docker-compose.yml
  deploy/docker-compose.yml
  deploy/nginx/conf.d/fluxmedia.conf
)
readonly MODELS_DIR=apps/web/models

fail() {
  printf '计算平台指纹失败：%s\n' "$1" >&2
  exit 1
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  else
    shasum -a 256 | awk '{ print $1 }'
  fi
}

begin_count="$(grep -c '^# platform-fingerprint:begin ' Dockerfile.unified || true)"
end_count="$(grep -c '^# platform-fingerprint:end ' Dockerfile.unified || true)"
[ "${begin_count}" -ge 1 ] && [ "${begin_count}" = "${end_count}" ] \
  || fail "Dockerfile.unified 的 platform-fingerprint 标记不成对"

{
  printf 'format 1\n'
  printf 'Dockerfile.unified %s\n' "$(
    awk '/^# platform-fingerprint:begin /{ inside = 1 } inside { print } /^# platform-fingerprint:end /{ inside = 0 }' \
      Dockerfile.unified | sha256_stream
  )"
  for file in "${PLATFORM_FILES[@]}"; do
    [ -f "${file}" ] || fail "缺少 ${file}"
    printf '%s %s\n' "${file}" "$(sha256_stream <"${file}")"
  done
  [ -d "${MODELS_DIR}" ] || fail "缺少 ${MODELS_DIR}"
  find "${MODELS_DIR}" -type f ! -name '.*' -print | LC_ALL=C sort | while IFS= read -r file; do
    printf '%s %s\n' "${file}" "$(sha256_stream <"${file}")"
  done
} | sha256_stream
