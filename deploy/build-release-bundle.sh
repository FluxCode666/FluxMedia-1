#!/usr/bin/env bash
# 构建 FluxMedia Release 部署包与 manifest。
#
# 使用方：.github/workflows/release.yml 的 publish-release job；release-bundle.test.sh。
# 参数：--output DIR --version TAG --git-sha SHA --app-image IMAGE --app-digest DIGEST
#       [--app-bundle FILE --platform-fingerprint FP]
# 产物（写入 DIR）：
#   fluxmedia-deploy.tar.gz  扁平部署包，文件名即目标服务器 deploy_path 中的文件名
#   fluxmedia-release.env    manifest：版本、提交、镜像 digest 与部署包 SHA-256；
#                            传入应用包时追加站内更新所需的应用包 SHA-256 与平台指纹
# 部署包是生产部署文件的唯一清单：Deploy Production 只使用它落地脚本、Compose 与
# Nginx 配置，保证发布内容与 Release 版本一一对应。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 源路径（相对 deploy/）与部署包内目标文件名。
readonly BUNDLE_FILES=(
  "docker-compose.yml:docker-compose.next.yml"
  "create-database-backup.sh:create-database-backup.sh"
  "read-release-ledger-digest.sh:read-release-ledger-digest.sh"
  "release-recovery-policy.sh:release-recovery-policy.sh"
  "read-env-value.sh:read-env-value.sh"
  "nginx/conf.d/fluxmedia.conf:fluxmedia.conf"
  "smoke-production-routing.sh:smoke-production-routing.sh"
  "deploy-release.sh:deploy-release.sh"
  "apply-release.sh:apply-release.sh"
  "read-release-manifest.sh:read-release-manifest.sh"
)

fail() {
  printf '构建部署包失败：%s\n' "$1" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

output_dir=""
version=""
git_sha=""
app_image=""
app_digest=""
app_bundle=""
platform_fingerprint=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "$1 缺少参数值"
  case "$1" in
    --output) output_dir="$2" ;;
    --version) version="$2" ;;
    --git-sha) git_sha="$2" ;;
    --app-image) app_image="$2" ;;
    --app-digest) app_digest="$2" ;;
    --app-bundle) app_bundle="$2" ;;
    --platform-fingerprint) platform_fingerprint="$2" ;;
    *) fail "未知参数：$1" ;;
  esac
  shift 2
done
[ -n "${output_dir}" ] && [ -n "${version}" ] && [ -n "${git_sha}" ] \
  && [ -n "${app_image}" ] && [ -n "${app_digest}" ] \
  || fail "--output、--version、--git-sha、--app-image、--app-digest 均必填"
if [ -n "${app_bundle}" ] || [ -n "${platform_fingerprint}" ]; then
  [ -f "${app_bundle}" ] && [ -n "${platform_fingerprint}" ] \
    || fail "--app-bundle 与 --platform-fingerprint 必须同时提供"
fi

mkdir -p "${output_dir}"
bundle_dir="$(mktemp -d "${output_dir}/bundle.XXXXXX")"
trap 'rm -rf "${bundle_dir}"' EXIT

bundle_names=()
for entry in "${BUNDLE_FILES[@]}"; do
  source_path="${script_dir}/${entry%%:*}"
  bundle_name="${entry#*:}"
  [ -f "${source_path}" ] || fail "缺少部署文件 ${entry%%:*}"
  cp "${source_path}" "${bundle_dir}/${bundle_name}"
  chmod 644 "${bundle_dir}/${bundle_name}"
  bundle_names+=("${bundle_name}")
done

tarball="${output_dir}/fluxmedia-deploy.tar.gz"
manifest="${output_dir}/fluxmedia-release.env"
# COPYFILE_DISABLE 防止 macOS 本地测试时混入 AppleDouble 元数据文件。
COPYFILE_DISABLE=1 tar -czf "${tarball}" -C "${bundle_dir}" "${bundle_names[@]}"

{
  printf 'RELEASE_TAG=%s\n' "${version}"
  printf 'GIT_SHA=%s\n' "${git_sha}"
  printf 'APP_IMAGE=%s\n' "${app_image}"
  printf 'APP_DIGEST=%s\n' "${app_digest}"
  printf 'BUNDLE_SHA256=%s\n' "$(sha256_file "${tarball}")"
  if [ -n "${app_bundle}" ]; then
    printf 'APP_BUNDLE_SHA256=%s\n' "$(sha256_file "${app_bundle}")"
    printf 'PLATFORM_FINGERPRINT=%s\n' "${platform_fingerprint}"
  fi
} >"${manifest}"

# 用与服务器相同的解析器自检，避免发布一个服务器必然拒绝的 manifest。
bash "${script_dir}/read-release-manifest.sh" "${manifest}" "${version}" >/dev/null
printf '部署包：%s\nmanifest：%s\n' "${tarball}" "${manifest}"
