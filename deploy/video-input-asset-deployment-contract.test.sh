#!/usr/bin/env bash
# 视频输入资产生产收编的静态回归测试。
# 锁定本地对象存储、持久回滚清单和非 root 状态目录三项部署契约。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
workflow_path="${repository_root}/.github/workflows/deploy-production.yml"
readme_path="${repository_root}/deploy/README.md"
compose_path="${repository_root}/deploy/docker-compose.yml"

require_text() {
  file_path="$1"
  expected="$2"
  if ! grep -Fq -- "${expected}" "${file_path}"; then
    printf '视频输入资产发布缺少契约：%s\n文件：%s\n' \
      "${expected}" "${file_path}" >&2
    exit 1
  fi
}

require_text \
  "${workflow_path}" \
  '--volume "${storage_path}:/app/storage"'
require_text \
  "${readme_path}" \
  '--volume "/root/docker-data/fluxmedia:/app/storage"'
for file_path in "${workflow_path}" "${readme_path}"; do
  require_text \
    "${file_path}" \
    'VIDEO_INPUT_ROLLBACK_MANIFEST=/app/state/video-input-rollback-'
done

require_text \
  "${workflow_path}" \
  '--volume "${deploy_path}/state:/app/state"'
require_text \
  "${workflow_path}" \
  'app_uid="$(docker run --rm --entrypoint id "${app_ref}" -u)"'
require_text "${workflow_path}" 'storage_path=/root/docker-data/fluxmedia'
require_text "${workflow_path}" 'test -w /app/storage'
require_text \
  "${workflow_path}" \
  'install -d -m 700 \'

storage_mount_count="$(
  grep -Fc -- '- /root/docker-data/fluxmedia:/app/storage' "${compose_path}"
)"
if [ "${storage_mount_count}" -ne 1 ]; then
  printf '统一 app 必须只挂载一次生产图片存储目录。\n' >&2
  exit 1
fi

require_text "${workflow_path}" 'candidate_compose run --rm --no-deps \'
require_text "${workflow_path}" '              app \'

prepare_line="$(
  grep -nF 'prepare_video_input_migration_state' "${workflow_path}" \
    | tail -1 | cut -d: -f1
)"
migration_started_line="$(
  grep -nF 'migration_started=true' "${workflow_path}" \
    | tail -1 | cut -d: -f1
)"
asset_migration_line="$(
  grep -nF 'run_video_input_asset_migration' "${workflow_path}" \
    | tail -1 | cut -d: -f1
)"
if [ -z "${prepare_line}" ] || [ -z "${migration_started_line}" ] \
  || [ -z "${asset_migration_line}" ]; then
  printf '无法定位状态目录、迁移边界或资产收编命令。\n' >&2
  exit 1
fi
if [ "${prepare_line}" -ge "${migration_started_line}" ] \
  || [ "${migration_started_line}" -ge "${asset_migration_line}" ]; then
  printf '状态目录必须在迁移边界前准备，资产收编必须在边界后执行。\n' >&2
  exit 1
fi

printf '视频输入资产发布契约测试通过。\n'
