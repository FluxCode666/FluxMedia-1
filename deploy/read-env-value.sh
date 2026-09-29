#!/usr/bin/env bash
# 生产部署使用的单行 dotenv 值读取器。
# 使用方：deploy-release.sh（目标服务器）。
# 只解析指定键，不 source/eval 配置内容或输出其他值。

set -euo pipefail

# 去除字符串两端的 dotenv 水平空白，保留值内部空白。
trim_dotenv_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

# 从单行 dotenv 文件读取最后一个指定键。
# 解析完整包裹值的引号并拒绝不完整或歧义引号。
read_dotenv_value() {
  local env_file="$1"
  local key="$2"
  local assignment_pattern
  local line
  local raw_value=""
  local value
  local quote
  local quoted_pattern
  local found="false"

  if [ ! -r "${env_file}" ]; then
    printf 'dotenv 文件不可读：%s\n' "${env_file}" >&2
    return 1
  fi
  if [[ ! "${key}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf 'dotenv 键名非法：%s\n' "${key}" >&2
    return 1
  fi

  assignment_pattern="^[[:space:]]*${key}[[:space:]]*=(.*)$"
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    if [[ "${line}" =~ ${assignment_pattern} ]]; then
      raw_value="${BASH_REMATCH[1]}"
      found="true"
    fi
  done <"${env_file}"

  if [ "${found}" != "true" ]; then
    return 0
  fi

  value="$(trim_dotenv_whitespace "${raw_value}")"
  if [ -z "${value}" ]; then
    return 0
  fi

  quote="${value:0:1}"
  if [ "${quote}" = "'" ] || [ "${quote}" = '"' ]; then
    # 只接受一对完整包裹值的引号。部署配置无需转义引号，遇到同类内嵌
    # 引号时 fail-closed，避免贪婪捕获把尾随非法文本当作值的一部分。
    if [ "${quote}" = "'" ]; then
      quoted_pattern="^'([^']*)'[[:space:]]*(#.*)?$"
    else
      quoted_pattern='^"([^"]*)"[[:space:]]*(#.*)?$'
    fi
    if [[ ! "${value}" =~ ${quoted_pattern} ]]; then
      printf 'dotenv 键 %s 的引号不匹配。\n' "${key}" >&2
      return 1
    fi
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi

  value="${value%%[[:space:]]#*}"
  value="$(trim_dotenv_whitespace "${value}")"
  if [[ "${value}" == *"'"* ]] || [[ "${value}" == *'"'* ]]; then
    printf 'dotenv 键 %s 的引号不匹配。\n' "${key}" >&2
    return 1
  fi
  printf '%s' "${value}"
}

# 校验命令行参数并把读取结果作为唯一标准输出。
main() {
  if [ "$#" -ne 2 ]; then
    printf '用法：bash read-env-value.sh <dotenv-file> <key>\n' >&2
    return 2
  fi
  read_dotenv_value "$1" "$2"
}

main "$@"
