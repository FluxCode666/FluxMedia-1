#!/usr/bin/env bash
# 严格解析 FluxMedia Release manifest（fluxmedia-release.env）。
#
# 使用方：build-release-bundle.sh（发布前自检）、fetch-release-bundle.sh（下载后校验）、
# apply-release.sh（落地前复核）。
# 参数：<manifest_path> [expected_release_tag]
# 输出：按固定顺序打印 RELEASE_TAG、GIT_SHA、APP_IMAGE、APP_DIGEST、BUNDLE_SHA256
# 五行 KEY=value；任何缺失、重复、未知键或格式非法都以非零退出且不输出任何值。
# 为什么不 source：manifest 来自网络下载，按 shell 执行会把远程内容变成 root 命令。

set -euo pipefail

readonly VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$'
readonly IMAGE_PATTERN='^ghcr\.io/fluxcode666/[a-z0-9][a-z0-9._-]*$'

fail() {
  printf 'Release manifest 校验失败：%s\n' "$1" >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] \
  || fail "用法：read-release-manifest.sh <manifest_path> [expected_release_tag]"
manifest_path="$1"
expected_release_tag="${2:-}"

[ -f "${manifest_path}" ] && [ ! -L "${manifest_path}" ] \
  || fail "manifest 不存在或不是普通文件"
[ "$(wc -c <"${manifest_path}")" -le 4096 ] || fail "manifest 过大"

release_tag=""
git_sha=""
app_image=""
app_digest=""
bundle_sha256=""

while IFS= read -r line || [ -n "${line}" ]; do
  [ -n "${line}" ] || continue
  [[ "${line}" == *=* ]] || fail "存在非 KEY=value 行"
  key="${line%%=*}"
  value="${line#*=}"
  case "${key}" in
    RELEASE_TAG) [ -z "${release_tag}" ] || fail "RELEASE_TAG 重复"; release_tag="${value}" ;;
    GIT_SHA) [ -z "${git_sha}" ] || fail "GIT_SHA 重复"; git_sha="${value}" ;;
    APP_IMAGE) [ -z "${app_image}" ] || fail "APP_IMAGE 重复"; app_image="${value}" ;;
    APP_DIGEST) [ -z "${app_digest}" ] || fail "APP_DIGEST 重复"; app_digest="${value}" ;;
    BUNDLE_SHA256) [ -z "${bundle_sha256}" ] || fail "BUNDLE_SHA256 重复"; bundle_sha256="${value}" ;;
    *) fail "未知键 ${key}" ;;
  esac
done <"${manifest_path}"

[[ "${release_tag}" =~ ${VERSION_PATTERN} ]] || fail "RELEASE_TAG 非法"
[[ "${git_sha}" =~ ^[0-9a-f]{40}$ ]] || fail "GIT_SHA 非法"
[[ "${app_image}" =~ ${IMAGE_PATTERN} ]] || fail "APP_IMAGE 非法"
[[ "${app_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "APP_DIGEST 非法"
[[ "${bundle_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "BUNDLE_SHA256 非法"
if [ -n "${expected_release_tag}" ] \
  && [ "${release_tag}" != "${expected_release_tag}" ]; then
  fail "RELEASE_TAG 与请求版本不一致"
fi

printf 'RELEASE_TAG=%s\n' "${release_tag}"
printf 'GIT_SHA=%s\n' "${git_sha}"
printf 'APP_IMAGE=%s\n' "${app_image}"
printf 'APP_DIGEST=%s\n' "${app_digest}"
printf 'BUNDLE_SHA256=%s\n' "${bundle_sha256}"
