#!/usr/bin/env bash
# 生产数据库备份脚本的回归测试。
# 使用方：生产部署质量门。
# 覆盖无 S3 配置时的本地回退、部分配置拒绝与远端加密上传证据。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_script="${script_dir}/create-database-backup.sh"
test_dir="$(mktemp -d)"
fake_bin="${test_dir}/bin"
deploy_path="${test_dir}/deploy"
env_file="${deploy_path}/.env"
git_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
image_tag="v0.10.1"
age_recipient="age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
age_recipient+="qqqqqqqqqqqqqqqqqqqqqqqqqqq"

# 删除本测试创建的命令替身、配置和备份文件。
# 不接触真实部署目录或数据库。
cleanup_test_files() {
  rm -rf "${test_dir}"
}
trap cleanup_test_files EXIT

mkdir -p "${fake_bin}" "${deploy_path}"

# 写入可执行命令替身。
# 参数为文件名与完整脚本文本，失败时由调用方直接终止测试。
write_fake_command() {
  local name="$1"
  local content="$2"
  printf '%s\n' "${content}" >"${fake_bin}/${name}"
  chmod 700 "${fake_bin}/${name}"
}

# 断言文件包含指定固定文本。
# 参数为用例名、文件路径和期望片段。
assert_file_contains() {
  local case_name="$1"
  local file_path="$2"
  local expected="$3"
  if ! grep -Fq -- "${expected}" "${file_path}"; then
    printf '用例失败：%s\n缺少文本：%s\n' "${case_name}" "${expected}" >&2
    return 1
  fi
}

# 断言命令以非零状态失败并包含指定错误。
# 其余参数作为待执行命令传入，防止部分配置被静默降级。
assert_rejected() {
  local case_name="$1"
  local expected_error="$2"
  shift 2
  if "$@" >"${test_dir}/rejected.out" 2>"${test_dir}/rejected.err"; then
    printf '用例失败：%s 应拒绝执行\n' "${case_name}" >&2
    return 1
  fi
  assert_file_contains "${case_name}" "${test_dir}/rejected.err" "${expected_error}"
}

write_fake_command "pg_dump" '#!/usr/bin/env bash
set -euo pipefail
if [ -n "${PGDATABASE:-}" ]; then
  printf "测试禁止通过 PGDATABASE 传入 URI 连接串\n" >&2
  exit 1
fi
database_url=""
output=""
schema_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dbname)
      database_url="$2"
      shift 2
      ;;
    --dbname=*)
      database_url="${1#--dbname=}"
      shift
      ;;
    --file)
      output="$2"
      shift 2
      ;;
    --schema-only|-s)
      schema_only=true
      shift
      ;;
    *)
      shift
      ;;
  esac
done
: "${database_url:?pg_dump 缺少 --dbname}"
[ "${database_url}" = "postgresql://flux:secret@db:5432/flux" ]
if [ "${FAKE_PG_DUMP_VERSION_MISMATCH:-false}" = "true" ]; then
  if [ "${schema_only}" != "true" ]; then
    exit 0
  fi
  printf "pg_dump: error: aborting because of server version mismatch\n" >&2
  printf "pg_dump: detail: server version: 18.4; pg_dump version: 16.14\n" >&2
  exit 1
fi
if [ "${schema_only}" = "true" ]; then
  if [ -n "${output}" ]; then
    printf "fake-schema-dump" >"${output}"
  else
    printf "fake-schema-dump"
  fi
  exit 0
fi
: "${output:?pg_dump 缺少 --file}"
printf "fake-custom-dump" >"${output}"'

write_fake_command "pg_restore" '#!/usr/bin/env bash
set -euo pipefail
archive="${2:-}"
[ "${1:-}" = "--list" ]
[ -s "${archive}" ]'

write_fake_command "date" '#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-u" ] && [ "${2:-}" = "-d" ]; then
  printf "2026-08-01T00:00:00Z\n"
else
  printf "20260725T000000Z\n"
fi'

# 本地回退不得调用远端加密工具；误调用时以特殊状态让测试立即失败。
write_fake_command "age" '#!/usr/bin/env bash
exit 97'
write_fake_command "aws" '#!/usr/bin/env bash
exit 98'

printf '%s\n' \
  'DATABASE_URL=postgresql://flux:secret@db:5432/flux' \
  'DEPLOY_BACKUP_RETENTION_DAYS=7' \
  >"${env_file}"

# preflight 必须真实连接数据库并执行只读 schema-only 探测。只检查命令存在
# 无法在停服前发现客户端与服务端版本不兼容，会让 create 阶段才暴露故障。
assert_rejected \
  "preflight 拒绝 pg_dump 服务端版本不兼容" \
  "server version mismatch" \
  env PATH="${fake_bin}:${PATH}" \
  FAKE_PG_DUMP_VERSION_MISMATCH=true \
  bash "${backup_script}" \
  preflight "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"

PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  preflight "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"
PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  create "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}" \
  >"${test_dir}/local.out"

assert_file_contains \
  "无 S3 配置回退本地" \
  "${test_dir}/local.out" \
  "backup_storage=local"
assert_file_contains \
  "本地 archive 可读取" \
  "${test_dir}/local.out" \
  "backup_archive_manifest_verified=true"
assert_file_contains \
  "本地落盘后摘要复核" \
  "${test_dir}/local.out" \
  "backup_storage_verified=true"
local_artifact_id="$(
  sed -n 's/^backup_artifact_id=//p' "${test_dir}/local.out" | tail -n 1
)"
local_backup_path="${local_artifact_id#file://}"
if [ "${local_backup_path}" = "${local_artifact_id}" ] \
  || [ ! -s "${local_backup_path}" ]; then
  printf '用例失败：本地备份 artifact 不存在：%s\n' \
    "${local_artifact_id}" >&2
  exit 1
fi
expected_local_sha="$(sha256sum "${local_backup_path}" | awk '{print $1}')"
assert_file_contains \
  "本地备份摘要匹配" \
  "${test_dir}/local.out" \
  "backup_artifact_sha256=${expected_local_sha}"

printf '%s\n' \
  'DATABASE_URL=postgresql://flux:secret@db:5432/flux' \
  'DEPLOY_BACKUP_S3_BUCKET=fluxmedia-production-backups' \
  >"${env_file}"
assert_rejected \
  "S3 部分配置" \
  "配置 DEPLOY_BACKUP_S3_BUCKET 时必须同时配置 DEPLOY_BACKUP_AGE_RECIPIENT。" \
  env PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  preflight "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"

printf '%s\n' \
  'DATABASE_URL=postgresql://flux:secret@db:5432/flux' \
  "DEPLOY_BACKUP_AGE_RECIPIENT=${age_recipient}" \
  >"${env_file}"
assert_rejected \
  "仅配置 age 公钥" \
  "配置 DEPLOY_BACKUP_AGE_RECIPIENT 或 DEPLOY_BACKUP_AWS_PROFILE 时必须同时配置 DEPLOY_BACKUP_S3_BUCKET。" \
  env PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  preflight "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"

write_fake_command "age" '#!/usr/bin/env bash
set -euo pipefail
output=""
input=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recipient)
      shift 2
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    *)
      input="$1"
      shift
      ;;
  esac
done
cp "${input}" "${output}"'

write_fake_command "aws" '#!/usr/bin/env bash
set -euo pipefail
operation="${2:-}"
case "${operation}" in
  get-bucket-versioning)
    printf "Enabled\n"
    ;;
  put-object)
    metadata=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--metadata" ]; then
        metadata="$2"
        break
      fi
      shift
    done
    printf "%s\n" "${metadata#sha256=}" >"${FAKE_AWS_STATE:?}"
    printf "version-123\n"
    ;;
  head-object)
    sed "s/,.*//" "${FAKE_AWS_STATE:?}"
    ;;
  *)
    printf "未知 aws 操作：%s\n" "${operation}" >&2
    exit 1
    ;;
esac'

printf '%s\n' \
  'DATABASE_URL=postgresql://flux:secret@db:5432/flux' \
  'DEPLOY_BACKUP_S3_BUCKET=fluxmedia-production-backups' \
  "DEPLOY_BACKUP_AGE_RECIPIENT=${age_recipient}" \
  'DEPLOY_BACKUP_S3_PREFIX=fluxmedia-production' \
  'DEPLOY_BACKUP_RETENTION_DAYS=7' \
  >"${env_file}"

export FAKE_AWS_STATE="${test_dir}/aws-state"
PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  preflight "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"
PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  create "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}" \
  >"${test_dir}/s3.out"

assert_file_contains \
  "完整 S3 配置使用远端备份" \
  "${test_dir}/s3.out" \
  "backup_storage=s3"
assert_file_contains \
  "S3 artifact 包含版本" \
  "${test_dir}/s3.out" \
  "backup_artifact_id=s3://fluxmedia-production-backups/fluxmedia-production/${image_tag}/20260725T000000Z-${git_sha}.dump.age?versionId=version-123"
assert_file_contains \
  "S3 元数据摘要复核" \
  "${test_dir}/s3.out" \
  "backup_storage_verified=true"

# S3 已选择后，上传失败不得静默切换到本地模式。
write_fake_command "aws" '#!/usr/bin/env bash
set -euo pipefail
operation="${2:-}"
if [ "${operation}" = "get-bucket-versioning" ]; then
  printf "Enabled\n"
  exit 0
fi
if [ "${operation}" = "put-object" ]; then
  printf "模拟 S3 上传失败\n" >&2
  exit 23
fi
exit 1'
local_file_count_before="$(
  find "${deploy_path}/backups" -type f -name '*.dump' | wc -l | tr -d ' '
)"
assert_rejected \
  "S3 上传失败不回退本地" \
  "模拟 S3 上传失败" \
  env PATH="${fake_bin}:${PATH}" bash "${backup_script}" \
  create "${env_file}" "${deploy_path}" "${image_tag}" "${git_sha}"
local_file_count_after="$(
  find "${deploy_path}/backups" -type f -name '*.dump' | wc -l | tr -d ' '
)"
if [ "${local_file_count_before}" != "${local_file_count_after}" ]; then
  printf '用例失败：S3 上传失败时创建了本地回退文件\n' >&2
  exit 1
fi

printf '生产数据库备份脚本测试通过。\n'
