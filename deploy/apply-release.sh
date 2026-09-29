#!/usr/bin/env bash
# 在目标服务器上落地一个已校验的 FluxMedia Release 部署包并执行生产发布。
#
# 使用方：
#   - .github/workflows/deploy-production.yml：scp 部署包到 incoming 目录后经 SSH 调用
#   - system-update-runner.sh：站内系统更新从 GitHub Release 下载部署包后调用
# 参数：--deploy-path DIR --bundle-dir DIR
# 行为：
#   1. 严格解析部署包内 release-manifest.env，得到镜像 digest、版本与提交。
#   2. 持有 deploy_path/release-state/deploy.lock，保证 Actions 与站内更新互斥。
#   3. 逐个“临时文件 + rename”原子放置部署文件，避免覆盖正在执行的脚本。
#   4. 调用本部署包自带的 deploy-release.sh；其标准输出即部署安全证据。
# 失败模式：锁被占用、manifest 非法或文件缺失时在任何服务变更前退出。

set -euo pipefail

readonly STAGED_FILES=(
  docker-compose.next.yml
  create-database-backup.sh
  read-release-ledger-digest.sh
  release-recovery-policy.sh
  read-env-value.sh
  fluxmedia.conf
  smoke-production-routing.sh
  deploy-release.sh
  apply-release.sh
  read-release-manifest.sh
  fetch-release-bundle.sh
  system-update-runner.sh
  install-system-updater.sh
  fluxmedia-system-update.service
  fluxmedia-system-update.path
)

fail() {
  printf '落地部署包失败：%s\n' "$1" >&2
  exit 1
}

deploy_path=""
bundle_dir=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "$1 缺少参数值"
  case "$1" in
    --deploy-path) deploy_path="$2" ;;
    --bundle-dir) bundle_dir="$2" ;;
    *) fail "未知参数：$1" ;;
  esac
  shift 2
done

[[ "${deploy_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || fail "--deploy-path 必须是不含空格的绝对路径"
[ -d "${deploy_path}" ] && [ ! -L "${deploy_path}" ] \
  || fail "部署目录不存在：${deploy_path}"
[ -n "${bundle_dir}" ] && [ -d "${bundle_dir}" ] || fail "--bundle-dir 不存在"
command -v flock >/dev/null 2>&1 || fail "服务器缺少 flock"

manifest_values="$(
  bash "${bundle_dir}/read-release-manifest.sh" \
    "${bundle_dir}/release-manifest.env"
)"
manifest_value() {
  printf '%s\n' "${manifest_values}" | awk -F= -v key="$1" '$1 == key { print $2 }'
}
release_tag="$(manifest_value RELEASE_TAG)"
git_sha="$(manifest_value GIT_SHA)"
app_image="$(manifest_value APP_IMAGE)"
app_digest="$(manifest_value APP_DIGEST)"

for file_name in "${STAGED_FILES[@]}"; do
  [ -f "${bundle_dir}/${file_name}" ] && [ ! -L "${bundle_dir}/${file_name}" ] \
    || fail "部署包缺少 ${file_name}"
done

install -d -m 700 "${deploy_path}/release-state"
exec 9>"${deploy_path}/release-state/deploy.lock"
flock -n 9 || fail "另一个生产部署正在进行，请等待其完成"

printf '落地部署包 %s（%s）。\n' "${release_tag}" "${git_sha}"
for file_name in "${STAGED_FILES[@]}"; do
  case "${file_name}" in
    *.sh) file_mode=750 ;;
    *) file_mode=640 ;;
  esac
  staging_path="${deploy_path}/.${file_name}.staging.$$"
  install -m "${file_mode}" "${bundle_dir}/${file_name}" "${staging_path}"
  # rename 生成新 inode：正在执行旧脚本的 bash 继续读取旧内容，不会读到半新文件。
  mv -f "${staging_path}" "${deploy_path}/${file_name}"
done

cd "${deploy_path}"
bash ./deploy-release.sh \
  "${app_image}" "${app_digest}" "${release_tag}" "${deploy_path}" "${git_sha}" \
  </dev/null
