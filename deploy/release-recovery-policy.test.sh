#!/usr/bin/env bash
# 生产部署退出恢复策略的纯逻辑回归测试。
# 使用方：生产部署质量门；覆盖真实视频契约下迁移前恢复与迁移后维护边界。
# 关键依赖：release-recovery-policy.sh 的四个布尔入参与单行决策输出。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_script="${script_dir}/release-recovery-policy.sh"
test_dir="$(mktemp -d)"

# 删除本测试创建的错误输出，不接触部署配置或 Docker 服务。
cleanup_test_files() {
  rm -rf "${test_dir}"
}
trap cleanup_test_files EXIT

# 断言给定部署状态只返回预期决策且命令成功。
# 参数依次为用例名、期望决策及策略脚本的四个布尔入参。
# 策略缺失、非法输出或非零退出均失败，防止退出 trap 静默跳过恢复。
assert_policy_decision() {
  local case_name="$1"
  local expected="$2"
  local actual
  local error_file="${test_dir}/policy.err"
  shift 2

  if ! actual="$(bash "${policy_script}" "$@" 2>"${error_file}")"; then
    printf '用例失败：%s 的恢复策略执行失败。\n' "${case_name}" >&2
    if [ -s "${error_file}" ]; then
      sed 's/^/策略错误：/' "${error_file}" >&2
    fi
    return 1
  fi
  if [ -s "${error_file}" ]; then
    printf '用例失败：%s 成功时不应输出错误。\n' "${case_name}" >&2
    sed 's/^/策略错误：/' "${error_file}" >&2
    return 1
  fi
  if [ "${actual}" != "${expected}" ]; then
    printf '用例失败：%s\n期望：%s\n实际：%s\n' \
      "${case_name}" "${expected}" "${actual}" >&2
    return 1
  fi
}

# 数据库已经应用真实视频契约，但资产/SQL 迁移尚未开始时，上一版本本就
# 运行在同一 schema 上；恢复动作不得再调用只允许旧 schema 的 legacy 门禁。
assert_policy_decision \
  "真实视频契约下迁移未开始时恢复原本运行的上一版本" \
  "restart-previous" \
  false true true true

assert_policy_decision \
  "迁移开始后保持维护状态" \
  "keep-maintenance" \
  true true true true

assert_policy_decision \
  "上一版本原本未运行时保持维护状态" \
  "keep-maintenance" \
  false true false true

assert_policy_decision \
  "Web 未停止时无需执行恢复动作" \
  "no-action" \
  false false true true

assert_policy_decision \
  "上一版本元数据不可用时保持维护状态" \
  "keep-maintenance" \
  false true true false

printf '生产部署退出恢复策略测试通过。\n'
