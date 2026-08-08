#!/usr/bin/env bash
# 生产迁移数据库连接隔离的回归测试。
# 使用方：生产部署质量门；确保迁移容器不会回退到 Web 的运行时数据库账号。
# 关键依赖：Docker Compose 的 config JSON 输出与 docker-compose.yml 环境变量映射。

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${script_dir}/docker-compose.yml"
test_dir="$(mktemp -d)"

# 删除本测试创建的临时 dotenv 与 Compose 配置，不接触真实部署文件。
cleanup_test_files() {
  rm -rf "${test_dir}"
}
trap cleanup_test_files EXIT

# 断言 Compose 分别将最小权限运行时连接与 DDL owner 连接传给对应服务。
# 参数为 Compose JSON 文件路径；映射错误、缺少服务或 URL 泄漏到错误服务都会失败。
assert_database_url_isolation() {
  local compose_json="$1"

  node --input-type=module - "${compose_json}" <<'NODE'
import { readFile } from "node:fs/promises";

const composeJsonPath = process.argv[2];
const config = JSON.parse(await readFile(composeJsonPath, "utf8"));
const webUrl = config.services?.web?.environment?.DATABASE_URL;
const webMigrationUrl = config.services?.web?.environment?.DATABASE_MIGRATION_URL;
const migrationUrl = config.services?.migrate?.environment?.DATABASE_URL;

if (webUrl !== "postgresql://fluxmedia_runtime@db:5432/fluxmedia") {
  throw new Error("Web 服务未使用最小权限 DATABASE_URL");
}

if (migrationUrl !== "postgresql://fluxmedia_ddl_owner@db:5432/fluxmedia") {
  throw new Error("迁移服务未使用 DATABASE_MIGRATION_URL");
}

if (webMigrationUrl !== "") {
  throw new Error("Web 服务不应接收 DATABASE_MIGRATION_URL");
}
NODE
}

# 断言缺少 DDL owner 连接时，Compose 在启动任何服务前拒绝配置。
# 参数为 dotenv 文件路径；拒绝原因必须指向迁移连接，避免回退到运行时账号。
assert_missing_migration_url_rejected() {
  local missing_env="$1"
  local error_file="${test_dir}/missing-migration-url.err"
  local status

  if docker compose \
    --env-file "${missing_env}" \
    -f "${compose_file}" \
    --profile maintenance \
    config --quiet >"${test_dir}/missing-migration-url.out" 2>"${error_file}"; then
    status=0
  else
    status="$?"
  fi

  if [ "${status}" -eq 0 ]; then
    printf '用例失败：缺少 DATABASE_MIGRATION_URL 时 Compose 不应通过。\n' >&2
    return 1
  fi
  if ! grep -Fq 'DATABASE_MIGRATION_URL' "${error_file}"; then
    printf '用例失败：缺少迁移连接时未返回预期错误。\n' >&2
    sed 's/^/实际错误：/' "${error_file}" >&2
    return 1
  fi
}

compose_env="${test_dir}/compose.env"
missing_migration_url_env="${test_dir}/missing-migration-url.env"
compose_json="${test_dir}/compose.json"
printf '%s\n' \
  'FLUXMEDIA_TAG=test' \
  'DATABASE_URL=postgresql://fluxmedia_runtime@db:5432/fluxmedia' \
  'DATABASE_MIGRATION_URL=postgresql://fluxmedia_ddl_owner@db:5432/fluxmedia' \
  'BETTER_AUTH_SECRET=test-auth-secret' \
  'REDIS_HOST=redis' \
  'REDIS_PASSWORD=test-redis-password' \
  'ADOBE_DIRECT_PROXY_SECRET=test-proxy-secret' \
  >"${compose_env}"

docker compose \
  --env-file "${compose_env}" \
  -f "${compose_file}" \
  --profile maintenance \
  config --format json >"${compose_json}"

assert_database_url_isolation "${compose_json}"

grep -v '^DATABASE_MIGRATION_URL=' "${compose_env}" \
  >"${missing_migration_url_env}"
assert_missing_migration_url_rejected "${missing_migration_url_env}"

printf '生产迁移数据库连接隔离测试通过。\n'
