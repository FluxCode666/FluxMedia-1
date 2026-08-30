#!/usr/bin/env bash
# 运营总览 epoch 发布门禁的静态回归测试。
# 使用方：生产部署质量门。锁定 migrator 镜像、Web 命令与远程发布顺序，避免迁移成功
# 但 epoch 仍为空时启动 Web 并宣告发布成功。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
workflow_path="${repository_root}/.github/workflows/deploy-production.yml"
dockerfile_path="${repository_root}/Dockerfile.web"
package_path="${repository_root}/apps/web/package.json"
compose_path="${repository_root}/deploy/docker-compose.yml"
operation_path="${repository_root}/packages/shared/src/uol/operations/operations-dashboard-facts.ts"

# 断言指定文件包含稳定发布契约文本。
require_text() {
  file_path="$1"
  expected="$2"
  if ! grep -Fq -- "${expected}" "${file_path}"; then
    printf '发布门禁缺少契约：%s\n文件：%s\n' \
      "${expected}" "${file_path}" >&2
    exit 1
  fi
}

# 断言旧的人工日期入口已彻底移除，避免它抢先写入任意不可变 epoch。
forbid_text() {
  file_path="$1"
  forbidden="$2"
  if grep -Fq -- "${forbidden}" "${file_path}"; then
    printf '发布门禁仍包含禁止的人工 epoch 入口：%s\n文件：%s\n' \
      "${forbidden}" "${file_path}" >&2
    exit 1
  fi
}

require_text \
  "${package_path}" \
  '"operations:epoch:ensure-current"'
forbid_text \
  "${package_path}" \
  '"operations:epoch:init"'
forbid_text \
  "${operation_path}" \
  'operations.initializeEpoch'
require_text \
  "${dockerfile_path}" \
  'COPY scripts/with-root-env.mjs ./scripts/with-root-env.mjs'
app_time_zone_count="$(
  grep -Fc -- 'APP_TIME_ZONE: ${APP_TIME_ZONE:-Asia/Shanghai}' "${compose_path}"
)"
if [ "${app_time_zone_count}" -ne 2 ]; then
  printf 'migrate 与 web 必须共享同一个 APP_TIME_ZONE 默认值。\n' >&2
  exit 1
fi
require_text \
  "${workflow_path}" \
  'run_operations_epoch_gate()'
require_text \
  "${workflow_path}" \
  'OPERATIONS_EPOCH_INITIALIZED_BY=release-${image_tag}'
require_text \
  "${workflow_path}" \
  'pnpm --dir apps/web operations:epoch:ensure-current'

web_start_line="$(
  grep -nF 'if ! docker compose up -d --remove-orphans web; then' \
    "${workflow_path}" | cut -d: -f1
)"
epoch_gate_line="$(
  grep -nF 'if ! run_operations_epoch_gate; then' "${workflow_path}" \
    | cut -d: -f1
)"
deployment_success_line="$(
  grep -nF 'deployment_succeeded=true' "${workflow_path}" \
    | cut -d: -f1
)"
if [ -z "${web_start_line}" ] || [ -z "${epoch_gate_line}" ] \
  || [ -z "${deployment_success_line}" ]; then
  printf '无法定位 Web 启动、epoch 门禁或发布成功标记。\n' >&2
  exit 1
fi
if [ "${web_start_line}" -ge "${epoch_gate_line}" ]; then
  printf '首次 epoch 必须在新 Web 事实写入路径启动后初始化。\n' >&2
  exit 1
fi
if [ "${epoch_gate_line}" -ge "${deployment_success_line}" ]; then
  printf 'epoch 门禁必须在发布成功标记前完成。\n' >&2
  exit 1
fi

printf '运营总览 epoch 发布门禁契约测试通过。\n'
