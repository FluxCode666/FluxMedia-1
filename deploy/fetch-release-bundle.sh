#!/usr/bin/env bash
# 从公开 GitHub Release 下载并校验 FluxMedia 部署包。
#
# 使用方：
#   - system-update-runner.sh（目标服务器，站内系统更新）
#   - .github/workflows/deploy-production.yml（Actions runner，手动部署）
# 参数：<release_tag> <dest_dir>
# 结果：dest_dir/bundle/ 为已校验的扁平部署包（含 release-manifest.env）；
#       标准输出为 read-release-manifest.sh 的规范化 KEY=value 行。
# 信任边界：仓库公开，匿名 HTTPS 下载即可；manifest 只经严格解析，部署包必须与
# manifest 中的 SHA-256 一致，且包内只允许扁平普通文件，杜绝路径穿越与符号链接。
# 环境：FLUXMEDIA_RELEASE_BASE_URL 可覆盖下载根地址（仅测试用 file:// 源）。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DEFAULT_BASE_URL="https://github.com/FluxCode666/FluxMedia-1/releases/download"
readonly MANIFEST_ASSET="fluxmedia-release.env"
readonly BUNDLE_ASSET="fluxmedia-deploy.tar.gz"
readonly VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$'

fail() {
  printf '下载部署包失败：%s\n' "$1" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

[ "$#" -eq 2 ] || fail "用法：fetch-release-bundle.sh <release_tag> <dest_dir>"
release_tag="$1"
dest_dir="$2"
base_url="${FLUXMEDIA_RELEASE_BASE_URL:-${DEFAULT_BASE_URL}}"

[[ "${release_tag}" =~ ${VERSION_PATTERN} ]] || fail "版本号非法"
command -v curl >/dev/null 2>&1 || fail "缺少 curl"
if [ -e "${dest_dir}" ] && [ -n "$(ls -A "${dest_dir}")" ]; then
  fail "目标目录非空：${dest_dir}"
fi
mkdir -p "${dest_dir}/bundle"

download() {
  local asset="$1"
  local target="$2"
  # 只允许 HTTPS（含 GitHub 到对象存储的重定向）；file 仅供测试源使用。
  curl --fail --silent --show-error --location \
    --proto '=https,file' --proto-redir '=https' \
    --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 \
    --output "${target}" \
    "${base_url}/${release_tag}/${asset}" \
    || fail "无法下载 ${release_tag}/${asset}；请确认该 Release 已由 Release 流水线发布部署包"
}

manifest_path="${dest_dir}/${MANIFEST_ASSET}"
tarball_path="${dest_dir}/${BUNDLE_ASSET}"
download "${MANIFEST_ASSET}" "${manifest_path}"
manifest_values="$(
  bash "${script_dir}/read-release-manifest.sh" "${manifest_path}" "${release_tag}"
)"
expected_sha256="$(
  printf '%s\n' "${manifest_values}" | awk -F= '$1 == "BUNDLE_SHA256" { print $2 }'
)"

download "${BUNDLE_ASSET}" "${tarball_path}"
actual_sha256="$(sha256_file "${tarball_path}")"
[ "${actual_sha256}" = "${expected_sha256}" ] \
  || fail "部署包 SHA-256 与 manifest 不一致"

# 解包前逐项检查：只接受扁平的普通文件，拒绝目录、链接、设备与 ../ 路径。
while IFS= read -r entry; do
  [[ "${entry}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || fail "部署包含非法文件名：${entry}"
done < <(tar -tzf "${tarball_path}")
while IFS= read -r entry_type; do
  [ "${entry_type}" = "-" ] || fail "部署包只能包含普通文件"
done < <(tar -tvzf "${tarball_path}" | cut -c1)

tar -xzf "${tarball_path}" -C "${dest_dir}/bundle" --no-same-owner
cp "${manifest_path}" "${dest_dir}/bundle/release-manifest.env"

printf '%s\n' "${manifest_values}"
