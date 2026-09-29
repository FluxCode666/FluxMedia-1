#!/usr/bin/env bash
# 安装或刷新 FluxMedia 站内系统更新器（宿主机 systemd path + service）。
#
# 使用方：deploy-release.sh 在停服前调用（每次发布幂等刷新）；运维也可手动执行。
# 参数：--deploy-path DIR --app-uid UID --app-gid GID
# 目录布局（均位于 FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR，默认 /var/lib/fluxmedia/system-update）：
#   status/     root 755：status.json，只读挂载进 app 供页面展示
#   requests/   app 用户 700：app 唯一可写处，只放更新请求
#   processing/ logs/ work/  root 700：runner 私有
# 安全边界：app 只能写 requests/；runner 以 root 运行但只把请求当作版本号输入，
# 再从公开 Release 下载并校验部署包，绝不执行请求中的其他内容。
# 测试环境变量：FLUXMEDIA_SYSTEMD_UNIT_DIR、FLUXMEDIA_SYSTEMCTL（覆盖 systemctl 命令）。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR:-/var/lib/fluxmedia/system-update}"
unit_dir="${FLUXMEDIA_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
systemctl_command="${FLUXMEDIA_SYSTEMCTL:-systemctl}"
readonly SERVICE_UNIT="fluxmedia-system-update.service"
readonly PATH_UNIT="fluxmedia-system-update.path"

fail() {
  printf '安装站内系统更新器失败：%s\n' "$1" >&2
  exit 1
}

deploy_path=""
app_uid=""
app_gid=""
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "$1 缺少参数值"
  case "$1" in
    --deploy-path) deploy_path="$2" ;;
    --app-uid) app_uid="$2" ;;
    --app-gid) app_gid="$2" ;;
    *) fail "未知参数：$1" ;;
  esac
  shift 2
done

[[ "${deploy_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || fail "--deploy-path 必须是不含空格的绝对路径"
[[ "${app_uid}" =~ ^[0-9]+$ ]] && [[ "${app_gid}" =~ ^[0-9]+$ ]] \
  || fail "--app-uid/--app-gid 必须是数字"
[ "${app_uid}" != "0" ] || fail "app 不得以 root 运行"
[[ "${state_dir}" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "状态目录非法"
for command_name in python3 flock curl; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "服务器缺少 ${command_name}"
done

# 每一级都拒绝符号链接，避免 root 被引导写入其他位置。
ensure_directory() {
  local path="$1"
  local mode="$2"
  local owner="$3"
  [ ! -L "${path}" ] || fail "拒绝符号链接目录：${path}"
  install -d -m "${mode}" "${path}"
  chmod "${mode}" "${path}"
  chown "${owner}" "${path}"
}

current_user="$(id -u):$(id -g)"
root_owner="${current_user}"
app_owner="${app_uid}:${app_gid}"
if [ "$(id -u)" != "0" ]; then
  # 非 root 仅用于测试：无法 chown 给其他用户，改用当前用户。
  app_owner="${current_user}"
fi

ensure_directory "$(dirname "${state_dir}")" 755 "${root_owner}"
ensure_directory "${state_dir}" 755 "${root_owner}"
ensure_directory "${state_dir}/status" 755 "${root_owner}"
ensure_directory "${state_dir}/requests" 700 "${app_owner}"
ensure_directory "${state_dir}/processing" 700 "${root_owner}"
ensure_directory "${state_dir}/logs" 700 "${root_owner}"
ensure_directory "${state_dir}/work" 700 "${root_owner}"

if [ ! -f "${state_dir}/status/status.json" ]; then
  FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR="${state_dir}" \
    bash "${script_dir}/system-update-runner.sh" --write-idle-status
fi

render_unit() {
  local source_name="$1"
  local target_path="${unit_dir}/${source_name}"
  local rendered
  rendered="$(mktemp)"
  sed -e "s|@DEPLOY_PATH@|${deploy_path}|g" -e "s|@STATE_DIR@|${state_dir}|g" \
    "${script_dir}/${source_name}" >"${rendered}"
  if [ -f "${target_path}" ] && cmp -s "${rendered}" "${target_path}"; then
    rm -f "${rendered}"
    return 1
  fi
  install -m 644 "${rendered}" "${target_path}"
  rm -f "${rendered}"
  return 0
}

install -d -m 755 "${unit_dir}"
units_changed=false
if render_unit "${SERVICE_UNIT}"; then units_changed=true; fi
if render_unit "${PATH_UNIT}"; then units_changed=true; fi

if [ "${units_changed}" = "true" ]; then
  "${systemctl_command}" daemon-reload
fi
"${systemctl_command}" enable "${PATH_UNIT}" >/dev/null
# 不重启 service：本脚本可能正由该 service 触发的发布调用，重启会中断发布。
if [ "${units_changed}" = "true" ]; then
  "${systemctl_command}" restart "${PATH_UNIT}"
else
  "${systemctl_command}" start "${PATH_UNIT}"
fi

printf '站内系统更新器已就绪：%s\n' "${state_dir}"
