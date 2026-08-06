#!/usr/bin/env bash
# 生产数据库迁移前备份入口。
# 使用方：deploy-production.yml 在目标服务器上执行 preflight/create。
# 完整 S3 配置使用版本化加密远端备份，未配置 S3 时回退到部署目录内的持久化本地备份。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_reader="${script_dir}/read-env-value.sh"

# 输出命令行用法。
# 参数错误时由 main 返回状态 2，不读取部署配置。
print_usage() {
  printf '%s\n' \
    "用法：bash create-database-backup.sh <preflight|create> <dotenv-file> <deploy-path> <image-tag> <git-sha>" \
    >&2
}

# 从受测 dotenv 读取器获取单个配置值。
# 读取失败时原样上抛，不 source/eval 目标服务器配置。
read_env_value() {
  local env_file="$1"
  local key="$2"
  bash "${env_reader}" "${env_file}" "${key}"
}

# 校验部署上下文，防止本地备份写出部署目录或构造非预期对象键。
# 参数为 dotenv、部署绝对路径、镜像 tag 与 40 位 Git SHA。
validate_deployment_context() {
  local env_file="$1"
  local deploy_path="$2"
  local image_tag="$3"
  local git_sha="$4"

  if [ ! -r "${env_file}" ]; then
    printf '部署环境文件不可读：%s\n' "${env_file}" >&2
    return 1
  fi
  if [[ ! "${deploy_path}" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    printf '部署路径必须是不含空格的绝对路径。\n' >&2
    return 1
  fi
  if [[ ! "${image_tag}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf '镜像 tag 只能包含安全字符。\n' >&2
    return 1
  fi
  if [[ ! "${git_sha}" =~ ^[a-f0-9]{40}$ ]]; then
    printf 'Git SHA 必须是 40 位小写十六进制。\n' >&2
    return 1
  fi
}

# 加载并校验备份配置，设置后续函数只读的全局快照。
# S3 bucket 未配置且没有远端凭据时选择 local；远端配置不完整则 fail-closed。
load_backup_config() {
  local env_file="$1"

  database_url="$(read_env_value "${env_file}" DATABASE_URL)"
  backup_bucket="$(read_env_value "${env_file}" DEPLOY_BACKUP_S3_BUCKET)"
  backup_prefix="$(read_env_value "${env_file}" DEPLOY_BACKUP_S3_PREFIX)"
  backup_age_recipient="$(
    read_env_value "${env_file}" DEPLOY_BACKUP_AGE_RECIPIENT
  )"
  backup_retention_days="$(
    read_env_value "${env_file}" DEPLOY_BACKUP_RETENTION_DAYS
  )"
  backup_aws_profile="$(
    read_env_value "${env_file}" DEPLOY_BACKUP_AWS_PROFILE
  )"
  backup_prefix="${backup_prefix:-fluxmedia-production}"
  backup_retention_days="${backup_retention_days:-7}"

  : "${database_url:?DATABASE_URL 必填}"
  if [[ ! "${backup_prefix}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    printf 'DEPLOY_BACKUP_S3_PREFIX 只能包含安全路径字符。\n' >&2
    return 1
  fi
  if [[ ! "${backup_retention_days}" =~ ^[0-9]+$ ]] \
    || ((backup_retention_days < 1 || backup_retention_days > 30)); then
    printf 'DEPLOY_BACKUP_RETENTION_DAYS 必须位于 1 到 30。\n' >&2
    return 1
  fi
  if [ -n "${backup_aws_profile}" ] \
    && [[ ! "${backup_aws_profile}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    printf 'DEPLOY_BACKUP_AWS_PROFILE 不是安全的 profile 名称。\n' >&2
    return 1
  fi

  if [ -z "${backup_bucket}" ]; then
    if [ -n "${backup_age_recipient}" ] || [ -n "${backup_aws_profile}" ]; then
      printf '%s\n' \
        '配置 DEPLOY_BACKUP_AGE_RECIPIENT 或 DEPLOY_BACKUP_AWS_PROFILE 时必须同时配置 DEPLOY_BACKUP_S3_BUCKET。' \
        >&2
      return 1
    fi
    backup_storage="local"
    return
  fi

  backup_storage="s3"
  if [[ ! "${backup_bucket}" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
    printf 'DEPLOY_BACKUP_S3_BUCKET 不是有效的 S3 bucket 名称。\n' >&2
    return 1
  fi
  if [ -z "${backup_age_recipient}" ]; then
    printf '%s\n' \
      '配置 DEPLOY_BACKUP_S3_BUCKET 时必须同时配置 DEPLOY_BACKUP_AGE_RECIPIENT。' \
      >&2
    return 1
  fi
  if [[ ! "${backup_age_recipient}" =~ ^age1[0-9a-z]+$ ]]; then
    printf 'DEPLOY_BACKUP_AGE_RECIPIENT 必须是标准 age 公钥。\n' >&2
    return 1
  fi
}

# 断言备份模式需要的目标机工具全部存在。
# 本地模式不依赖 age/AWS CLI；S3 模式额外要求两者。
require_backup_commands() {
  local command_name
  local required_commands=(date install mktemp mv pg_dump pg_restore sha256sum)
  if [ "${backup_storage}" = "s3" ]; then
    required_commands+=(age aws)
  fi
  for command_name in "${required_commands[@]}"; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
      printf '目标服务器缺少生产备份工具：%s。\n' "${command_name}" >&2
      return 1
    fi
  done
}

# 用真实只读 schema-only dump 验证客户端版本、数据库权限与 archive 读取链路。
# 探测文件只存在于 mktemp 路径并在函数退出时删除，不读取业务表数据。
probe_backup_toolchain() (
  set -euo pipefail
  local probe_archive

  probe_archive="$(mktemp)"
  cleanup_probe_archive() {
    rm -f "${probe_archive}"
  }
  trap cleanup_probe_archive EXIT

  chmod 600 "${probe_archive}"
  pg_dump \
    --dbname="${database_url}" \
    --format=custom \
    --schema-only \
    --no-acl \
    --no-owner \
    --file "${probe_archive}"
  pg_restore --list "${probe_archive}" >/dev/null
)

# 准备本地备份目录并拒绝符号链接边界。
# 目录固定在 deploy-path/backups/<image-tag>，权限收紧为 0700。
prepare_local_backup_directory() {
  local deploy_path="$1"
  local image_tag="$2"
  local backup_root="${deploy_path}/backups"
  local backup_version_dir="${backup_root}/${image_tag}"

  if [ -L "${backup_root}" ] || [ -L "${backup_version_dir}" ]; then
    printf '本地备份目录不得是符号链接。\n' >&2
    return 1
  fi
  install -d -m 700 "${backup_version_dir}"
}

# 执行停服前备份预检。
# local 校验持久目录可创建；S3 校验 profile、工具与 bucket 版本控制。
run_preflight() {
  local deploy_path="$1"
  local image_tag="$2"
  local bucket_versioning

  require_backup_commands
  probe_backup_toolchain
  if [ "${backup_storage}" = "local" ]; then
    prepare_local_backup_directory "${deploy_path}" "${image_tag}"
    return
  fi

  if [ -n "${backup_aws_profile}" ]; then
    export AWS_PROFILE="${backup_aws_profile}"
  fi
  bucket_versioning="$(
    aws s3api get-bucket-versioning \
      --bucket "${backup_bucket}" \
      --query Status \
      --output text
  )"
  if [ "${bucket_versioning}" != "Enabled" ]; then
    printf '生产备份 bucket 必须启用版本控制。\n' >&2
    return 1
  fi
}

# 计算备份的人工销毁截止时间。
# 目标生产机为 GNU userland；非法保留期已在配置加载阶段拒绝。
calculate_delete_after() {
  date -u -d "+${backup_retention_days} days" +%Y-%m-%dT%H:%M:%SZ
}

# 输出传输无关的备份证据。
# artifact 不含数据库凭据；摘要覆盖最终落盘或上传的实际文件。
emit_backup_evidence() {
  local storage="$1"
  local artifact_id="$2"
  local artifact_sha256="$3"
  local delete_after="$4"

  printf 'backup_storage=%s\n' "${storage}"
  printf 'backup_artifact_id=%s\n' "${artifact_id}"
  printf 'backup_artifact_sha256=%s\n' "${artifact_sha256}"
  printf 'backup_delete_after=%s\n' "${delete_after}"
  printf 'backup_archive_manifest_verified=true\n'
  printf 'backup_storage_verified=true\n'
}

# 创建权限为 0600 的持久化本地 custom-format 备份。
# 写入 staging 后原子移动，并重新计算摘要确认最终文件未变化。
create_local_backup() (
  set -euo pipefail
  local deploy_path="$1"
  local image_tag="$2"
  local git_sha="$3"
  local backup_version_dir="${deploy_path}/backups/${image_tag}"
  local backup_timestamp
  local backup_plain
  local backup_final
  local artifact_sha256
  local persisted_sha256
  local delete_after

  prepare_local_backup_directory "${deploy_path}" "${image_tag}"
  backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_plain="$(mktemp "${backup_version_dir}/.staging.XXXXXX")"
  backup_final="${backup_version_dir}/${backup_timestamp}-${git_sha}.dump"

  # 只删除本次 mktemp 创建的 staging 文件，不触碰持久化备份。
  cleanup_local_staging() {
    rm -f "${backup_plain}"
  }
  trap cleanup_local_staging EXIT

  if [ -e "${backup_final}" ]; then
    printf '本地备份目标已存在，拒绝覆盖：%s\n' "${backup_final}" >&2
    return 1
  fi
  chmod 600 "${backup_plain}"
  # PGDATABASE 只按数据库名解释 URI，可能退回本机 socket；显式 --dbname
  # 才会让 libpq 按连接串解析服务器、凭据与 SSL 参数。
  pg_dump \
    --dbname="${database_url}" \
    --format=custom \
    --no-acl \
    --no-owner \
    --file "${backup_plain}"
  pg_restore --list "${backup_plain}" >/dev/null
  artifact_sha256="$(sha256sum "${backup_plain}" | awk '{print $1}')"
  mv "${backup_plain}" "${backup_final}"
  persisted_sha256="$(sha256sum "${backup_final}" | awk '{print $1}')"
  if [ "${persisted_sha256}" != "${artifact_sha256}" ]; then
    printf '本地备份落盘后的 SHA-256 校验失败。\n' >&2
    return 1
  fi
  delete_after="$(calculate_delete_after)"
  emit_backup_evidence \
    "local" \
    "file://${backup_final}" \
    "${artifact_sha256}" \
    "${delete_after}"
)

# 创建 age 加密备份并上传到版本化 S3 bucket。
# 明文和本地密文只存在于 mktemp 目录，任何退出路径都会精确清理。
create_s3_backup() (
  set -euo pipefail
  local image_tag="$1"
  local git_sha="$2"
  local backup_dir
  local backup_plain
  local backup_cipher
  local backup_timestamp
  local backup_key
  local artifact_sha256
  local version_id
  local remote_sha256
  local delete_after

  if [ -n "${backup_aws_profile}" ]; then
    export AWS_PROFILE="${backup_aws_profile}"
  fi
  backup_dir="$(mktemp -d)"
  backup_plain="${backup_dir}/fluxmedia.dump"
  backup_cipher="${backup_plain}.age"
  backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_key="${backup_prefix}/${image_tag}/${backup_timestamp}-${git_sha}.dump.age"

  # backup_dir 由本函数内 mktemp 创建，EXIT 时精确删除该目录。
  cleanup_s3_staging() {
    rm -rf "${backup_dir}"
  }
  trap cleanup_s3_staging EXIT

  umask 077
  # 与本地备份保持同一连接方式，避免远端模式因 URI 被当作数据库名而误连
  # 本机 PostgreSQL socket。
  pg_dump \
    --dbname="${database_url}" \
    --format=custom \
    --no-acl \
    --no-owner \
    --file "${backup_plain}"
  pg_restore --list "${backup_plain}" >/dev/null
  age --recipient "${backup_age_recipient}" \
    --output "${backup_cipher}" "${backup_plain}"
  rm -f "${backup_plain}"

  artifact_sha256="$(sha256sum "${backup_cipher}" | awk '{print $1}')"
  version_id="$(
    aws s3api put-object \
      --bucket "${backup_bucket}" \
      --key "${backup_key}" \
      --body "${backup_cipher}" \
      --metadata "sha256=${artifact_sha256},git-sha=${git_sha}" \
      --server-side-encryption AES256 \
      --query VersionId \
      --output text
  )"
  if [ -z "${version_id}" ] || [ "${version_id}" = "None" ]; then
    printf '备份存储未返回版本 ID，拒绝继续迁移。\n' >&2
    return 1
  fi

  remote_sha256="$(
    aws s3api head-object \
      --bucket "${backup_bucket}" \
      --key "${backup_key}" \
      --version-id "${version_id}" \
      --query 'Metadata.sha256' \
      --output text
  )"
  if [ "${remote_sha256}" != "${artifact_sha256}" ]; then
    printf '备份上传后的 SHA-256 元数据校验失败。\n' >&2
    return 1
  fi

  delete_after="$(calculate_delete_after)"
  emit_backup_evidence \
    "s3" \
    "s3://${backup_bucket}/${backup_key}?versionId=${version_id}" \
    "${artifact_sha256}" \
    "${delete_after}"
)

# 创建当前模式的数据库备份。
# create 前重跑 preflight，避免停服前后配置或工具状态变化被忽略。
create_backup() {
  local deploy_path="$1"
  local image_tag="$2"
  local git_sha="$3"

  run_preflight "${deploy_path}" "${image_tag}"
  if [ "${backup_storage}" = "local" ]; then
    create_local_backup "${deploy_path}" "${image_tag}" "${git_sha}"
  else
    create_s3_backup "${image_tag}" "${git_sha}"
  fi
}

# 校验参数、加载配置并执行 preflight 或 create。
# 所有失败均返回非零，调用方据此阻止数据库迁移。
main() {
  local command="${1:-}"
  local env_file="${2:-}"
  local deploy_path="${3:-}"
  local image_tag="${4:-}"
  local git_sha="${5:-}"

  if [ "$#" -ne 5 ] || { [ "${command}" != "preflight" ] \
    && [ "${command}" != "create" ]; }; then
    print_usage
    return 2
  fi
  validate_deployment_context \
    "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"
  load_backup_config "${env_file}"
  if [ "${command}" = "preflight" ]; then
    run_preflight "${deploy_path}" "${image_tag}"
  else
    create_backup "${deploy_path}" "${image_tag}" "${git_sha}"
  fi
}

main "$@"
