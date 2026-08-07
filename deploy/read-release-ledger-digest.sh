#!/usr/bin/env bash
# 发布门禁账本摘要的严格读取器。
# 使用方：deploy-production.yml 的质量门与远程生产部署脚本。
# 只接受标准输入中唯一一个小写 SHA-256 evidence，拒绝缺失、非法或重复值。

set -euo pipefail

# 从标准输入读取唯一的 credits_ledger_digest evidence。
# 不接受命令行参数；成功时只输出 64 位小写十六进制摘要。
main() {
  local line
  local candidate
  local digest=""
  local match_count=0

  if [ "$#" -ne 0 ]; then
    printf '用法：<release-gate-output> | bash read-release-ledger-digest.sh\n' >&2
    return 2
  fi

  while IFS= read -r line || [ -n "${line}" ]; do
    if [[ "${line}" != credits_ledger_digest=* ]]; then
      continue
    fi
    candidate="${line#credits_ledger_digest=}"
    if [[ ! "${candidate}" =~ ^[0-9a-f]{64}$ ]]; then
      printf '发布门禁账本摘要格式非法。\n' >&2
      return 1
    fi
    digest="${candidate}"
    match_count=$((match_count + 1))
  done

  if [ "${match_count}" -ne 1 ]; then
    printf '发布门禁账本摘要必须且只能出现一次，实际为 %s 次。\n' \
      "${match_count}" >&2
    return 1
  fi
  printf '%s\n' "${digest}"
}

main "$@"
