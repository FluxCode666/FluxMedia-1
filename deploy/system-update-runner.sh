#!/usr/bin/env bash
# FluxMedia 站内系统更新执行器（宿主机 root，由 systemd path 单元触发）。
#
# 使用方：
#   - fluxmedia-system-update.service：处理 app 写入的 requests/update-request.json
#   - 运维手动：bash system-update-runner.sh --deploy-path /root/fluxmedia --version vX.Y.Z
#   - install-system-updater.sh：--write-idle-status 初始化状态文件
# 流程：取走请求 → 校验版本（仅稳定版且必须高于当前版本）→ 从公开 GitHub Release
#       下载并校验部署包 → apply-release.sh 执行与 Actions 完全相同的发布 → 校验证据。
# 状态：status/status.json（root 写、app 只读），记录阶段、错误码与日志尾部。
# 安全：请求文件位于 app 可写目录，只解析其中的版本号与请求元数据；先 rename 到
#       root 私有目录再读取，避免符号链接与读写竞争。完整日志只保存在 root 私有目录。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${FLUXMEDIA_SYSTEM_UPDATE_STATE_DIR:-/var/lib/fluxmedia/system-update}"
readonly STABLE_VERSION_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly KEEP_LOG_COUNT=20

status_path="${state_dir}/status/status.json"
request_path="${state_dir}/requests/update-request.json"

deploy_path="${script_dir}"
manual_version=""
write_idle_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --deploy-path)
      [ "$#" -ge 2 ] || { echo "--deploy-path 缺少参数值" >&2; exit 2; }
      deploy_path="$2"
      shift 2
      ;;
    --version)
      [ "$#" -ge 2 ] || { echo "--version 缺少参数值" >&2; exit 2; }
      manual_version="$2"
      shift 2
      ;;
    --write-idle-status)
      write_idle_only=true
      shift
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 2
      ;;
  esac
done

now_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

target_version=""
previous_version=""
request_id=""
requested_by=""
started_at=""
finished_at=""
log_file=""
current_state=""

# 原子写入状态 JSON。值经环境变量传给 python，避免任何字符串拼接进 JSON 或代码。
# 参数：<state> [phase] [error_code]
write_status() {
  current_state="$1"
  STATUS_STATE="$1" \
  STATUS_PHASE="${2:-}" \
  STATUS_ERROR="${3:-}" \
  STATUS_TARGET_VERSION="${target_version}" \
  STATUS_PREVIOUS_VERSION="${previous_version}" \
  STATUS_REQUEST_ID="${request_id}" \
  STATUS_REQUESTED_BY="${requested_by}" \
  STATUS_STARTED_AT="${started_at}" \
  STATUS_FINISHED_AT="${finished_at}" \
  STATUS_UPDATED_AT="$(now_utc)" \
  STATUS_LOG_FILE="${log_file}" \
    python3 - "${status_path}" <<'PY'
import json
import os
import sys
import tempfile

path = sys.argv[1]


def value(name):
    raw = os.environ.get(name, "")
    return raw if raw else None


log_tail = []
log_file = value("STATUS_LOG_FILE")
if log_file and os.path.isfile(log_file):
    with open(log_file, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        handle.seek(max(0, handle.tell() - 65536))
        text = handle.read().decode("utf-8", "replace")
    log_tail = [line[:400] for line in text.splitlines()[-60:]]

document = {
    "schemaVersion": 1,
    "state": value("STATUS_STATE"),
    "phase": value("STATUS_PHASE"),
    "error": value("STATUS_ERROR"),
    "targetVersion": value("STATUS_TARGET_VERSION"),
    "previousVersion": value("STATUS_PREVIOUS_VERSION"),
    "requestId": value("STATUS_REQUEST_ID"),
    "requestedBy": value("STATUS_REQUESTED_BY"),
    "startedAt": value("STATUS_STARTED_AT"),
    "finishedAt": value("STATUS_FINISHED_AT"),
    "updatedAt": value("STATUS_UPDATED_AT"),
    "logTail": log_tail,
}
directory = os.path.dirname(path)
descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".status.")
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump(document, handle, ensure_ascii=False)
    handle.write("\n")
os.chmod(temporary, 0o644)
os.replace(temporary, path)
PY
}

log_line() {
  printf '[%s] %s\n' "$(now_utc)" "$1" | tee -a "${log_file:-/dev/null}" >&2
}

finish_failed() {
  finished_at="$(now_utc)"
  log_line "系统更新失败：$1"
  write_status failed "" "$1"
  exit 1
}

if [ "${write_idle_only}" = "true" ]; then
  if [ ! -f "${status_path}" ]; then
    write_status idle
  fi
  exit 0
fi

[[ "${deploy_path}" =~ ^/[A-Za-z0-9._/-]+$ ]] || {
  echo "--deploy-path 必须是不含空格的绝对路径" >&2
  exit 2
}
for directory in status requests processing logs work; do
  if [ ! -d "${state_dir}/${directory}" ] || [ -L "${state_dir}/${directory}" ]; then
    echo "站内系统更新目录未初始化：${state_dir}/${directory}" >&2
    exit 1
  fi
done

exec 8>"${state_dir}/runner.lock"
if ! flock -n 8; then
  # 另一个 runner（通常是运维手动执行）正在发布：丢弃重复请求，避免 path 单元反复触发。
  if [ -z "${manual_version}" ] && [ -e "${request_path}" ]; then
    rm -rf "${request_path}"
    echo "已有系统更新在执行，丢弃重复请求。" >&2
  fi
  [ -z "${manual_version}" ] || { echo "已有系统更新在执行。" >&2; exit 1; }
  exit 0
fi

work_dir=""
on_exit() {
  status="$?"
  if [ -n "${work_dir}" ]; then
    rm -rf "${work_dir}"
  fi
  if [ "${current_state}" = "running" ]; then
    finished_at="$(now_utc)"
    write_status failed "" runner_interrupted || true
  fi
  # 只保留最近的日志，避免长期运行后占满磁盘。
  find "${state_dir}/logs" -maxdepth 1 -type f -name '*.log' -print \
    | sort -r | tail -n "+$((KEEP_LOG_COUNT + 1))" | xargs -r rm -f || true
  return "${status}"
}
trap on_exit EXIT
trap 'exit 143' TERM INT HUP

if [ -n "${manual_version}" ]; then
  target_version="${manual_version}"
  requested_by="operator"
  request_id="manual-$(date -u +%Y%m%dT%H%M%SZ)"
else
  # rename 不跟随符号链接；落入 root 私有目录后 app 无法再替换该文件。
  claimed_path="${state_dir}/processing/request.json"
  rm -rf "${claimed_path}"
  if ! mv -f "${request_path}" "${claimed_path}" 2>/dev/null; then
    exit 0
  fi
  started_at="$(now_utc)"
  if [ -L "${claimed_path}" ] || [ ! -f "${claimed_path}" ]; then
    rm -rf "${claimed_path}"
    finish_failed invalid_request
  fi
  if ! parsed_request="$(
    python3 - "${claimed_path}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], "rb") as handle:
    raw = handle.read(4097)
if len(raw) > 4096:
    sys.exit(1)
document = json.loads(raw.decode("utf-8"))
if not isinstance(document, dict):
    sys.exit(1)
version = document.get("version")
request_id = document.get("requestId")
requested_by = document.get("requestedBy", "")
if not isinstance(version, str) or not re.fullmatch(r"v\d{1,6}\.\d{1,6}\.\d{1,6}", version):
    sys.exit(1)
if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", request_id):
    sys.exit(1)
if not isinstance(requested_by, str) or not re.fullmatch(r"[A-Za-z0-9_-]{0,128}", requested_by):
    sys.exit(1)
print(f"{version}\t{request_id}\t{requested_by}")
PY
  )"; then
    rm -f "${claimed_path}"
    finish_failed invalid_request
  fi
  rm -f "${claimed_path}"
  IFS=$'\t' read -r target_version request_id requested_by <<<"${parsed_request}"
fi

started_at="${started_at:-$(now_utc)}"
log_file="${state_dir}/logs/$(date -u +%Y%m%dT%H%M%SZ)-${request_id}.log"
install -m 600 /dev/null "${log_file}"
write_status running validating
log_line "收到系统更新请求：目标版本 ${target_version}，请求者 ${requested_by:-unknown}。"

[[ "${target_version}" =~ ${STABLE_VERSION_PATTERN} ]] \
  || finish_failed invalid_version

if ! previous_version="$(
  bash "${deploy_path}/read-env-value.sh" "${deploy_path}/.env" FLUXMEDIA_RELEASE_TAG
)" || [ -z "${previous_version}" ]; then
  previous_version=""
  finish_failed current_version_unknown
fi
write_status running validating

# 只允许升级：app 即使被攻破，也只能请求部署比当前更新的官方稳定版本。
if ! python3 - "${previous_version}" "${target_version}" <<'PY'
import re
import sys

pattern = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$")


def key(version):
    match = pattern.fullmatch(version)
    if not match:
        raise SystemExit(1)
    major, minor, patch, channel, number = match.groups()
    order = {"alpha": 0, "beta": 1, "rc": 2}
    prerelease = (3, 0) if channel is None else (order[channel], int(number))
    return (int(major), int(minor), int(patch), prerelease)


raise SystemExit(0 if key(sys.argv[2]) > key(sys.argv[1]) else 1)
PY
then
  finish_failed version_not_newer
fi

write_status running downloading
log_line "从 GitHub Release 下载并校验 ${target_version} 部署包。"
work_dir="$(mktemp -d "${state_dir}/work/${target_version}.XXXXXX")"
if ! manifest_values="$(
  bash "${script_dir}/fetch-release-bundle.sh" \
    "${target_version}" "${work_dir}/release" 2>>"${log_file}"
)"; then
  finish_failed download_failed
fi
app_image="$(printf '%s\n' "${manifest_values}" | awk -F= '$1 == "APP_IMAGE" { print $2 }')"
app_digest="$(printf '%s\n' "${manifest_values}" | awk -F= '$1 == "APP_DIGEST" { print $2 }')"

write_status running deploying
log_line "开始发布 ${app_image}@${app_digest}。"
if ! bash "${work_dir}/release/bundle/apply-release.sh" \
  --deploy-path "${deploy_path}" \
  --bundle-dir "${work_dir}/release/bundle" \
  >>"${log_file}" 2>&1 </dev/null; then
  finish_failed deploy_failed
fi

# 与 Actions 相同：只有部署脚本输出完成证据且镜像与 manifest 一致才算成功。
if ! grep -qx 'deployment_completed=true' "${log_file}" \
  || ! grep -qxF "deployed_image_ref=${app_image}@${app_digest}" "${log_file}"; then
  finish_failed deploy_evidence_missing
fi

finished_at="$(now_utc)"
log_line "系统已更新到 ${target_version}。"
write_status succeeded
