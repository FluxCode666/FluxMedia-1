/**
 * 0077 API 上游适配版本迁移的升级前预检。
 *
 * 使用方：生产维护窗口在停止旧 Web、执行 0077 前运行。预检
 * 只读取旧 requestTransformScript 字段、成员 ID 和任务计数，不读取
 * API Key，不输出 URL、脚本、任务 ID、Prompt 或媒体。
 */
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  API_UPSTREAM_PROBE_MAX_SCRIPT_CHARACTERS,
  ApiUpstreamWorkerProbe,
  ApiUpstreamWorkerProbeError,
  parseApiUpstreamProbeRuntimeConfig,
} from "./api-upstream-worker-probe.mjs";

const REQUIRED_LEGACY_CONFIG_COLUMNS = [
  "member_id",
  "api_key",
  "base_url",
  "use_stream",
  "model_mappings",
  "request_transform_script",
];
const REQUIRED_VERSIONED_CONFIG_COLUMNS = [
  "member_id",
  "api_key",
  "current_adapter_version_id",
  "credential_scope",
];
const LEGACY_ONLY_CONFIG_COLUMNS = [
  "base_url",
  "use_stream",
  "model_mappings",
  "request_transform_script",
];

/** 只暴露稳定代码和脱敏维度的迁移预检错误。 */
export class ApiUpstreamMigrationPreflightError extends Error {
  /**
   * @param {string} code 稳定失败码。
   * @param {{ memberIds?: string[], count?: number }} [details] 可安全输出的维度。
   */
  constructor(code, details = {}) {
    super("API 上游适配迁移预检失败");
    this.name = "ApiUpstreamMigrationPreflightError";
    this.code = code;
    this.memberIds = details.memberIds;
    this.count = details.count;
  }
}

/**
 * 把旧“返回 Body”脚本包装成新请求信封脚本。
 *
 * @param {string} legacyScript 旧请求 Body 处理脚本。
 * @returns {string} 与 0077 SQL 语义相同的新脚本；空脚本保持为空。
 * @throws {ApiUpstreamMigrationPreflightError} 原脚本或包装结果超限时拒绝。
 */
export function wrapLegacyRequestTransformScript(legacyScript) {
  if (typeof legacyScript !== "string") {
    throw new ApiUpstreamMigrationPreflightError(
      "legacy_request_transform_script_shape_invalid"
    );
  }
  if (!legacyScript.trim()) return "";
  const wrapped = `const legacyBody = ((request) => {\n${legacyScript}\n})(request.body);\nreturn { body: legacyBody };`;
  if (
    legacyScript.length > API_UPSTREAM_PROBE_MAX_SCRIPT_CHARACTERS ||
    wrapped.length > API_UPSTREAM_PROBE_MAX_SCRIPT_CHARACTERS
  ) {
    throw new ApiUpstreamMigrationPreflightError(
      "legacy_request_transform_script_too_large"
    );
  }
  return wrapped;
}

/**
 * 根据 information_schema 列集合判断 0077 前后状态。
 *
 * @param {Iterable<string>} configColumns API 配置表的列名。
 * @param {boolean} versionTableExists 不可变版本表是否存在。
 * @returns {"legacy" | "versioned" | "partial"} 当前迁移形状。
 */
export function classifyApiUpstreamAdapterSchema(
  configColumns,
  versionTableExists
) {
  const columns = new Set(configColumns);
  const hasAllLegacy = REQUIRED_LEGACY_CONFIG_COLUMNS.every((column) =>
    columns.has(column)
  );
  const hasAnyLegacyOnly = LEGACY_ONLY_CONFIG_COLUMNS.some((column) =>
    columns.has(column)
  );
  const hasAllVersioned = REQUIRED_VERSIONED_CONFIG_COLUMNS.every((column) =>
    columns.has(column)
  );
  if (hasAllLegacy && !versionTableExists && !hasAllVersioned) return "legacy";
  if (hasAllVersioned && versionTableExists && !hasAnyLegacyOnly) {
    return "versioned";
  }
  return "partial";
}

/**
 * 输出一条无供应商正文的 JSON 事件。
 *
 * @param {string} event 稳定事件名。
 * @param {Record<string, unknown>} data 已脱敏字段。
 * @sideEffects 向 stdout 写入单行 JSON，便于本地或任意日志收集器消费。
 */
function writeEvent(event, data = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
}

/**
 * 查询当前 schema 的旧或新 API 适配表形状。
 *
 * @param {import("pg").PoolClient} client 已开启只读事务的连接。
 * @returns {Promise<{ columnsByTable: Map<string, Set<string>>, state: "legacy" | "versioned" | "partial" }>} 列快照和迁移状态。
 * @sideEffects 只查询 information_schema 和 to_regclass。
 */
async function readAdapterSchemaState(client) {
  const result = await client.query(`
    select
      table_name,
      column_name
    from information_schema.columns
    where table_schema = current_schema()
      and table_name in (
        'image_backend_member',
        'image_backend_member_api_config',
        'video_generation'
      )
    order by table_name, column_name
  `);
  const columnsByTable = new Map();
  for (const row of result.rows) {
    if (
      !row ||
      typeof row.table_name !== "string" ||
      typeof row.column_name !== "string"
    ) {
      throw new ApiUpstreamMigrationPreflightError(
        "database_schema_result_invalid"
      );
    }
    const columns = columnsByTable.get(row.table_name) ?? new Set();
    columns.add(row.column_name);
    columnsByTable.set(row.table_name, columns);
  }
  const versionResult = await client.query(`
    select to_regclass(
      current_schema() || '.image_backend_member_api_adapter_version'
    ) is not null as exists
  `);
  const versionTableExists = versionResult.rows[0]?.exists === true;
  return {
    columnsByTable,
    state: classifyApiUpstreamAdapterSchema(
      columnsByTable.get("image_backend_member_api_config") ?? [],
      versionTableExists
    ),
  };
}

/**
 * 确保预检所需成员与视频列完整存在。
 *
 * @param {Map<string, Set<string>>} columnsByTable 按表分组的列快照。
 * @returns {void} 形状完整时无返回值。
 * @throws {ApiUpstreamMigrationPreflightError} 成员或视频列缺失时拒绝。
 */
function assertSupportingSchema(columnsByTable) {
  const memberColumns = columnsByTable.get("image_backend_member") ?? new Set();
  const videoColumns = columnsByTable.get("video_generation") ?? new Set();
  if (
    !memberColumns.has("id") ||
    !memberColumns.has("type") ||
    !videoColumns.has("backend_member_id") ||
    !videoColumns.has("stage")
  ) {
    throw new ApiUpstreamMigrationPreflightError(
      "supporting_database_schema_incomplete"
    );
  }
}

/**
 * 统计仍绑定 API 成员的非终态视频。
 *
 * @param {import("pg").PoolClient} client 已开启只读事务的连接。
 * @returns {Promise<number>} 非终态 API 视频数量。
 * @sideEffects 只执行 count，不读取任务 ID。
 */
async function countNonterminalApiVideos(client) {
  const result = await client.query(`
    select count(*)::integer as count
    from video_generation as video
    inner join image_backend_member as member
      on member.id = video.backend_member_id
    where member.type = 'api'
      and video.stage not in ('completed', 'failed')
  `);
  const count = result.rows[0]?.count;
  if (!Number.isInteger(count) || count < 0) {
    throw new ApiUpstreamMigrationPreflightError(
      "nonterminal_api_video_count_invalid"
    );
  }
  return count;
}

/**
 * 读取 API 成员 ID 及旧脚本。
 *
 * @param {import("pg").PoolClient} client 已开启只读事务的连接。
 * @returns {Promise<Array<{ memberId: string, script: string }>>} 按成员 ID 排序的脚本。
 * @sideEffects SQL 故意不选择凭据和其他配置。
 */
async function readLegacyScripts(client) {
  const result = await client.query(`
    select
      member.id as member_id,
      config.request_transform_script
    from image_backend_member as member
    left join image_backend_member_api_config as config
      on config.member_id = member.id
    where member.type = 'api'
    order by member.id
  `);
  return result.rows.map((row) => {
    if (!row || typeof row.member_id !== "string") {
      throw new ApiUpstreamMigrationPreflightError(
        "legacy_request_transform_script_shape_invalid"
      );
    }
    if (typeof row.request_transform_script !== "string") {
      throw new ApiUpstreamMigrationPreflightError(
        "api_member_adapter_config_missing",
        { memberIds: [row.member_id] }
      );
    }
    return {
      memberId: row.member_id,
      script: row.request_transform_script,
    };
  });
}

/**
 * 用生产 QuickJS Worker 逐个编译迁移后的包装脚本。
 *
 * @param {Array<{ memberId: string, script: string }>} rows 旧成员脚本。
 * @returns {Promise<number>} 实际编译的非空脚本数量。
 * @sideEffects 惰性启动一个生产 Worker，并在 finally 中终止。
 * @throws {ApiUpstreamMigrationPreflightError} 任一成员脚本不可无损包装时拒绝。
 */
async function validateLegacyScripts(rows) {
  let probe;
  const invalidMemberIds = [];
  let validatedScriptCount = 0;
  try {
    for (const row of rows) {
      let wrapped;
      try {
        wrapped = wrapLegacyRequestTransformScript(row.script);
        if (!wrapped) continue;
        probe ??= new ApiUpstreamWorkerProbe();
        await probe.validate(wrapped);
        validatedScriptCount += 1;
      } catch (error) {
        if (
          error instanceof ApiUpstreamMigrationPreflightError ||
          error instanceof ApiUpstreamWorkerProbeError
        ) {
          invalidMemberIds.push(row.memberId);
          continue;
        }
        throw error;
      }
    }
  } finally {
    await probe?.close();
  }
  if (invalidMemberIds.length > 0) {
    throw new ApiUpstreamMigrationPreflightError(
      "legacy_request_transform_script_invalid",
      { memberIds: invalidMemberIds }
    );
  }
  return validatedScriptCount;
}

/**
 * 在一个可重复读只事务中执行完整预检。
 *
 * @param {import("pg").Pool} pool 只用于当前命令的 PostgreSQL Pool。
 * @returns {Promise<Record<string, unknown>>} 可安全写入日志的摘要。
 */
export async function runApiUpstreamAdapterMigrationPreflight(pool) {
  parseApiUpstreamProbeRuntimeConfig();
  const client = await pool.connect();
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only"
    );
    const schema = await readAdapterSchemaState(client);
    if (schema.state === "partial") {
      throw new ApiUpstreamMigrationPreflightError(
        "api_upstream_adapter_schema_partial"
      );
    }
    if (schema.state === "versioned") {
      await client.query("commit");
      return {
        schemaState: "versioned",
        validatedMemberCount: 0,
        validatedScriptCount: 0,
        nonterminalApiVideoCount: 0,
      };
    }

    assertSupportingSchema(schema.columnsByTable);
    const nonterminalApiVideoCount = await countNonterminalApiVideos(client);
    if (nonterminalApiVideoCount > 0) {
      throw new ApiUpstreamMigrationPreflightError(
        "nonterminal_api_video_tasks_present",
        { count: nonterminalApiVideoCount }
      );
    }
    const rows = await readLegacyScripts(client);
    const validatedScriptCount = await validateLegacyScripts(rows);
    await client.query("commit");
    return {
      schemaState: "legacy",
      validatedMemberCount: rows.length,
      validatedScriptCount,
      nonterminalApiVideoCount,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 执行命令行预检。
 *
 * @returns {Promise<void>} 数据库 Pool 已关闭时完成。
 * @sideEffects 读取 DATABASE_URL，连接 PostgreSQL，并只输出 allowlist JSON。
 * @failure 不打印异常正文或堆栈，失败时设置非零退出码。
 */
async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    writeEvent("api_upstream_adapter_migration_preflight_failed", {
      code: "database_url_missing",
    });
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: "api-upstream-adapter-migration-preflight",
  });
  try {
    const summary = await runApiUpstreamAdapterMigrationPreflight(pool);
    writeEvent("api_upstream_adapter_migration_preflight_passed", summary);
  } catch (error) {
    if (error instanceof ApiUpstreamMigrationPreflightError) {
      writeEvent("api_upstream_adapter_migration_preflight_failed", {
        code: error.code,
        ...(error.memberIds ? { memberIds: error.memberIds } : {}),
        ...(error.count === undefined ? {} : { count: error.count }),
      });
    } else if (error instanceof ApiUpstreamWorkerProbeError) {
      writeEvent("api_upstream_adapter_migration_preflight_failed", {
        code: error.code,
      });
    } else {
      writeEvent("api_upstream_adapter_migration_preflight_failed", {
        code: "database_query_failed",
      });
    }
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) await main();
