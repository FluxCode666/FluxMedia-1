#!/usr/bin/env bash
# 生产部署失败后的纯恢复决策。
# 使用方：deploy-production.yml 的 EXIT trap；不读取配置、不操作 Docker 或数据库。
# 关键依赖：调用方在任何写迁移前准确记录旧 Web 是否原本处于运行状态。

set -euo pipefail

# 输出固定用法；参数错误时不产生恢复决策。
print_usage() {
  printf '%s\n' \
    "用法：bash release-recovery-policy.sh <migration-started> <web-stopped> <previous-web-was-running> <previous-release-available>" \
    >&2
}

# 校验外部传入的布尔状态，拒绝空值、大小写别名与其他隐式真值。
# 参数为状态名称和值；非法值返回状态 2，不产生标准输出。
validate_boolean() {
  local name="$1"
  local value="$2"

  if [ "${value}" != "true" ] && [ "${value}" != "false" ]; then
    printf '%s 必须是 true 或 false。\n' "${name}" >&2
    return 2
  fi
}

# 根据迁移边界和旧服务运行证据返回唯一恢复动作。
# restart-previous 只在数据库尚未写入且旧 Web 原本运行时返回；调用方负责执行动作。
main() {
  if [ "$#" -ne 4 ]; then
    print_usage
    return 2
  fi

  local migration_started="$1"
  local web_stopped="$2"
  local previous_web_was_running="$3"
  local previous_release_available="$4"

  validate_boolean "migration-started" "${migration_started}"
  validate_boolean "web-stopped" "${web_stopped}"
  validate_boolean "previous-web-was-running" "${previous_web_was_running}"
  validate_boolean "previous-release-available" "${previous_release_available}"

  if [ "${migration_started}" = "true" ]; then
    printf 'keep-maintenance\n'
    return
  fi
  if [ "${web_stopped}" = "false" ]; then
    printf 'no-action\n'
    return
  fi
  if [ "${previous_web_was_running}" = "true" ] \
    && [ "${previous_release_available}" = "true" ]; then
    printf 'restart-previous\n'
    return
  fi
  printf 'keep-maintenance\n'
}

main "$@"
