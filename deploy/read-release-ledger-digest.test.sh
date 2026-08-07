#!/usr/bin/env bash
# 发布门禁账本摘要读取器的回归测试。
# 使用方：生产部署质量门。
# 覆盖合法提取以及缺失、非法、重复 evidence 的 fail-closed 行为。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
reader_path="${script_dir}/read-release-ledger-digest.sh"
test_dir="$(mktemp -d)"
digest="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# 删除本测试创建的输出文件，不接触部署配置或业务数据。
cleanup_test_files() {
  rm -rf "${test_dir}"
}
trap cleanup_test_files EXIT

# 断言读取器从混合日志中只返回合法摘要。
assert_digest() {
  local case_name="$1"
  local input="$2"
  local actual

  actual="$(printf '%s' "${input}" | bash "${reader_path}")"
  if [ "${actual}" != "${digest}" ]; then
    printf '用例失败：%s\n期望：%s\n实际：%s\n' \
      "${case_name}" "${digest}" "${actual}" >&2
    return 1
  fi
}

# 断言缺失、非法或重复摘要均以退出码 1 拒绝且不输出值。
assert_rejected() {
  local case_name="$1"
  local input="$2"
  local status

  if printf '%s' "${input}" | bash "${reader_path}" \
    >"${test_dir}/rejected.out" 2>"${test_dir}/rejected.err"; then
    status=0
  else
    status="$?"
  fi
  if [ "${status}" -ne 1 ]; then
    printf '用例失败：%s 退出码应为 1，实际为 %s\n' \
      "${case_name}" "${status}" >&2
    return 1
  fi
  if [ -s "${test_dir}/rejected.out" ]; then
    printf '用例失败：%s 拒绝时不应输出摘要\n' "${case_name}" >&2
    return 1
  fi
  if [ ! -s "${test_dir}/rejected.err" ]; then
    printf '用例失败：%s 拒绝时应输出可定位错误\n' "${case_name}" >&2
    return 1
  fi
}

assert_digest \
  "从 pnpm 混合输出提取摘要" \
  $'> @repo/database db:release-gate\ncredits_batch_active_count=0\ncredits_ledger_digest='"${digest}"$'\n'
assert_rejected "缺少摘要" $'credits_batch_active_count=0\n'
assert_rejected \
  "摘要不是小写 SHA-256" \
  $'credits_ledger_digest=ABCDEF\n'
assert_rejected \
  "重复摘要" \
  $'credits_ledger_digest='"${digest}"$'\ncredits_ledger_digest='"${digest}"$'\n'

printf '发布门禁账本摘要读取器测试通过。\n'
