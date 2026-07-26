/**
 * 生产迁移的只读 PostgreSQL 门禁。
 *
 * 使用方：deploy-production.yml 在停止旧 Web 后执行 drain/preflight，并在迁移后
 * 执行 postcheck。脚本只输出非敏感计数与状态，不输出连接串、行内容或凭据。
 */
import process from "node:process";

import pg from "pg";

const { Pool } = pg;
const GLOBAL_SETTING_KEY = "CONTENT_MODERATION_BLOCK_RISK_LEVEL";
const PLAN_MATRIX_SETTING_KEY = "PLAN_CAPABILITY_MATRIX";
const LEGACY_MEDIA_TABLES = [
  "image_backend_account",
  "image_backend_account_group",
  "image_backend_api",
  "image_backend_api_group",
  "image_backend_adobe",
  "image_backend_adobe_group",
  "adobe_account",
  "adobe_token",
  "image_backend_inflight_lease",
  "image_backend_sticky_binding",
  "image_backend_scheduler_metric",
];
const REQUIRED_MEDIA_TABLES = [
  "image_backend_member",
  "image_backend_member_api_config",
  "image_backend_member_adobe_config",
  "image_backend_member_group",
  "image_backend_member_lease",
  "image_backend_member_scheduler_metric",
  "video_generation_callback_delivery",
];
const REMOVED_MEDIA_SETTING_KEYS = [
  "IMAGE_MODERATION_PROMPT_REPAIR_ENABLED",
  "IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES",
  "PLATFORM_RESPONSES_MODEL",
  "PLATFORM_CHAT_MODEL",
  "IMAGE_AGENT_MAX_ROUNDS",
  "IMAGE_AGENT_FORCE_MAX_ROUNDS",
  "IMAGE_RESPONSES_PREVIOUS_RESPONSE_ENABLED",
  "IMAGE_FORCE_WEB_MIN_PIXELS",
  "IMAGE_FORCE_WEB_MAX_PIXELS",
  "CHATGPT_WEB_PROXY_URL",
  "CHATGPT_WEB_PROXY_SECRET",
  "CHATGPT_WEB_ACCOUNT_REFRESH_STALE_MINUTES",
  "CHATGPT_WEB_ACCOUNT_REFRESH_LIMIT",
  "SUB2API_POSTGRES_URL",
  "SUB2API_POSTGRES_SYNC_LIMIT",
  "SUB2API_AUTO_SYNC_TASKS",
  "EDITABLE_FILE_PPT_CREDITS",
  "EDITABLE_FILE_PSD_CREDITS",
  "INTERNAL_JOB_WEB_ACCOUNTS_REFRESH_INTERVAL_MINUTES",
  "INTERNAL_JOB_WEB_ACCOUNTS_REPLENISH_INTERVAL_MINUTES",
  "INTERNAL_JOB_SUB2API_SYNC_INTERVAL_MINUTES",
  "CHATGPT_REGISTER_MOEMAIL_API_KEY",
  "CHATGPT_REGISTER_MOEMAIL_BASE_URL",
  "CHATGPT_REGISTER_MOEMAIL_DOMAIN",
  "CHATGPT_REGISTER_DOMAINS",
  "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED",
  "CHATGPT_REGISTER_PROXY",
  "CHATGPT_REGISTER_PROXY_DISABLED",
  "CHATGPT_REGISTER_REFRESH_URL",
  "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
  "CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS",
  "CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED",
  "CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID",
  "CHATGPT_REGISTER_POOL_MAINTAIN_TARGET",
  "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN",
  "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY",
];
const REMOVED_PLAN_FEATURES = [
  "imageGeneration.chat",
  "imageGeneration.agent",
  "imageGeneration.waterfall",
  "export.ppt",
  "export.psd",
  "models.gpt55",
  "externalApi.chat.completions",
  "externalApi.responses",
  "externalApi.agent",
];
const REMOVED_PLAN_LIMITS = ["maxChatImages", "maxChatContextChars"];

/**
 * 将 PostgreSQL bigint 文本计数收窄为 JavaScript 安全整数。
 *
 * @param {unknown} value PostgreSQL 查询返回的计数值。
 * @param {string} label 仅用于错误定位且不得包含数据库内容的检查名称。
 * @returns {number} 非负且位于 Number 安全整数范围内的计数。
 * @throws 值无法转成非负安全整数时抛错。
 * @sideEffect 无副作用。
 * @boundary 接受 pg 默认返回的十进制字符串或等价数值；拒绝负数、NaN、Infinity
 *   与超过 Number.MAX_SAFE_INTEGER 的计数。
 */
function parseCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} returned an invalid count`);
  }
  return count;
}

/**
 * 输出部署脚本可解析的单行键值证据。
 *
 * @param {string} key 由调用方控制的稳定证据键。
 * @param {string | number | boolean} value 不包含数据库内容的证据值。
 * @returns {void} 不返回值。
 * @throws stdout 写入失败时由 Node.js 流实现抛错。
 * @sideEffect 向 process.stdout 写入一行文本。
 * @boundary 调用方必须保证 key 与 value 不含换行、凭据或数据库行内容。
 */
function printEvidence(key, value) {
  process.stdout.write(`${key}=${value}\n`);
}

/**
 * 在单个只读事务中执行门禁检查，并确保连接归还连接池。
 *
 * @param {pg.Pool} pool 已配置到目标数据库的 PostgreSQL 连接池。
 * @param {(client: pg.PoolClient) => Promise<void>} work 使用独占连接执行的检查。
 * @returns {Promise<void>} 检查成功并提交只读事务后完成的 Promise。
 * @throws 获取连接、开始/提交事务或 work 失败时原样抛错。
 * @sideEffect 获取并释放一个池连接，执行 BEGIN READ ONLY、COMMIT 或 ROLLBACK。
 * @boundary 回滚失败不会覆盖原始异常；finally 始终释放已获取的连接。
 */
async function inReadOnlyTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("begin read only");
    await work(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 确认当前数据库内旧 Web 的稳定 application_name 连接已全部排空。
 *
 * @param {pg.Pool} pool 已配置到目标生产数据库的连接池。
 * @returns {Promise<void>} 连接数为零时完成的 Promise。
 * @throws 查询失败、计数非法，或仍存在 fluxmedia-web 连接时抛错。
 * @sideEffect 在只读事务中查询 pg_stat_activity，并向 stdout 输出连接计数。
 * @boundary 仅统计当前数据库且排除当前后端进程；其他 application_name 不阻断。
 */
async function assertWebConnectionsDrained(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const result = await client.query(`
      select count(*)::text as count
      from pg_stat_activity
      where datname = current_database()
        and application_name = 'fluxmedia-web'
        and pid <> pg_backend_pid()
    `);
    const count = parseCount(result.rows[0]?.count, "web connection drain");
    printEvidence("web_connection_count", count);
    if (count !== 0) {
      throw new Error(`web connection drain failed: ${count} remain`);
    }
  });
}

/**
 * 检查历史纯中转数据，旧列已不存在时按后续发布成功处理。
 *
 * @param {pg.Pool} pool 已配置到目标生产数据库的连接池。
 * @returns {Promise<void>} relay_only 旧列缺失或 true 行数为零时完成的 Promise。
 * @throws 查询失败、计数非法，或发现 relay_only=true 的历史行时抛错。
 * @sideEffect 在只读事务中查询 schema 与 external_api_key，并输出列状态和计数。
 * @boundary 旧列缺失代表 0056 已完成；旧列存在时必须扫描真实数据并 fail closed。
 */
async function assertRelayPreflight(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const columnResult = await client.query(`
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'external_api_key'
          and column_name = 'relay_only'
      ) as present
    `);
    const columnPresent = columnResult.rows[0]?.present === true;
    printEvidence("relay_only_column", columnPresent ? "present" : "absent");
    if (!columnPresent) {
      printEvidence("relay_only_true_count", 0);
      return;
    }

    const countResult = await client.query(`
      select count(*)::text as count
      from external_api_key
      where relay_only is true
    `);
    const count = parseCount(
      countResult.rows[0]?.count,
      "relay-only preflight"
    );
    printEvidence("relay_only_true_count", count);
    if (count !== 0) {
      throw new Error(`relay-only preflight failed: ${count} rows found`);
    }
  });
}

/**
 * 验证 0060 切换前只有可迁移的 API/Adobe 数据，且旧 Web 与运行中状态已排空。
 * 已完成迁移后旧表或 adobe_id 列不存在，按后续发布的零行状态处理。
 */
async function assertMediaPreflight(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const markerResult = await client.query(
      "select to_regclass('public.image_backend_member') is not null as applied"
    );
    if (markerResult.rows[0]?.applied === true) {
      for (const tableName of LEGACY_MEDIA_TABLES) {
        printEvidence(`legacy_media_${tableName}_count`, 0);
      }
      printEvidence("legacy_media_video_adobe_reference_count", 0);
      printEvidence("legacy_media_total_count", 0);
      printEvidence("legacy_media_active_lease_count", 0);
      printEvidence("legacy_media_active_sticky_count", 0);
      printEvidence("legacy_media_active_video_count", 0);
      printEvidence("legacy_media_member_id_collision_count", 0);
      printEvidence("legacy_media_invalid_api_model_count", 0);
      printEvidence("legacy_media_incompatible_api_protocol_count", 0);
      printEvidence("legacy_media_invalid_adobe_config_count", 0);
      printEvidence("legacy_media_invalid_member_state_count", 0);
      printEvidence("legacy_media_invalid_direct_credential_count", 0);
      printEvidence("legacy_media_direct_member_id_collision_count", 0);
      printEvidence("legacy_media_blocker_total_count", 0);
      return;
    }
    const tableCounts = new Map();
    const presentTables = new Set();
    let legacyTotal = 0;
    for (const tableName of LEGACY_MEDIA_TABLES) {
      const existsResult = await client.query(
        "select to_regclass(format('public.%I', $1::text)) is not null as present",
        [tableName]
      );
      let count = 0;
      if (existsResult.rows[0]?.present === true) {
        presentTables.add(tableName);
        if (!/^[a-z_]+$/u.test(tableName)) {
          throw new Error("legacy media table name is invalid");
        }
        const countResult = await client.query(
          `select count(*)::text as count from "${tableName}"`
        );
        count = parseCount(countResult.rows[0]?.count, tableName);
      }
      printEvidence(`legacy_media_${tableName}_count`, count);
      tableCounts.set(tableName, count);
      legacyTotal += count;
    }

    const adobeColumnResult = await client.query(`
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'video_generation'
          and column_name = 'adobe_id'
      ) as present
    `);
    let videoReferenceCount = 0;
    if (adobeColumnResult.rows[0]?.present === true) {
      const countResult = await client.query(`
        select count(*)::text as count
        from video_generation
        where adobe_id is not null
      `);
      videoReferenceCount = parseCount(
        countResult.rows[0]?.count,
        "video_generation adobe references"
      );
    }
    printEvidence(
      "legacy_media_video_adobe_reference_count",
      videoReferenceCount
    );
    legacyTotal += videoReferenceCount;
    printEvidence("legacy_media_total_count", legacyTotal);

    const activeLeaseResult = presentTables.has("image_backend_inflight_lease")
      ? await client.query(`
          select count(*)::text as count
          from image_backend_inflight_lease
          where expires_at > now()
        `)
      : { rows: [{ count: "0" }] };
    const activeLeaseCount = parseCount(
      activeLeaseResult.rows[0]?.count,
      "active legacy media leases"
    );
    const activeStickyResult = presentTables.has("image_backend_sticky_binding")
      ? await client.query(`
          select count(*)::text as count
          from image_backend_sticky_binding
          where expires_at > now()
        `)
      : { rows: [{ count: "0" }] };
    const activeStickyCount = parseCount(
      activeStickyResult.rows[0]?.count,
      "active legacy sticky bindings"
    );
    const activeVideoResult =
      adobeColumnResult.rows[0]?.present === true
        ? await client.query(`
          select count(*)::text as count
          from video_generation
          where adobe_id is not null
            and status not in ('completed', 'failed')
        `)
        : { rows: [{ count: "0" }] };
    const activeVideoCount = parseCount(
      activeVideoResult.rows[0]?.count,
      "active legacy Adobe videos"
    );
    const memberCollisionResult =
      presentTables.has("image_backend_api") &&
      presentTables.has("image_backend_adobe")
        ? await client.query(`
            select count(*)::text as count
            from image_backend_api as api
            inner join image_backend_adobe as adobe on adobe.id = api.id
          `)
        : { rows: [{ count: "0" }] };
    const memberIdCollisionCount = parseCount(
      memberCollisionResult.rows[0]?.count,
      "legacy member ID collisions"
    );
    const apiModelColumnResult = await client.query(`
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'image_backend_api'
          and column_name = 'supported_model_ids'
      ) as present
    `);
    const invalidApiModelResult =
      apiModelColumnResult.rows[0]?.present === true
        ? await client.query(`
          select count(*)::text as count
          from image_backend_api
          where case
            when json_typeof(supported_model_ids) <> 'array' then true
            when json_array_length(supported_model_ids) not between 1 and 200
              then true
            else exists (
              select 1
              from json_array_elements(supported_model_ids) as model(value)
              where json_typeof(model.value) <> 'string'
                or char_length(btrim(model.value #>> '{}')) not between 1 and 120
                or lower(btrim(model.value #>> '{}')) ~
                  '^(firefly-sora2(-pro)?-(4|8|12)s-(9x16|16x9)|(firefly-)?veo31(-ref|-fast)?-(4|6|8)s-(16x9|9x16)-(1080p|720p)|(firefly-)?kling-o3-(5|15)s-(16x9|9x16)|(firefly-)?kling3-(5|10|15)s-(16x9|9x16))$'
            )
          end
        `)
        : { rows: [{ count: "0" }] };
    const invalidApiModelCount = parseCount(
      invalidApiModelResult.rows[0]?.count,
      "invalid legacy API models"
    );
    const apiProtocolColumnResult = await client.query(`
      select count(*)::integer as count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'image_backend_api'
        and column_name in ('interface_mode', 'image_upstream_mode')
    `);
    const incompatibleApiProtocolResult =
      apiProtocolColumnResult.rows[0]?.count === 2
        ? await client.query(`
            select count(*)::text as count
            from image_backend_api
            where interface_mode not in ('images', 'mixed')
              or image_upstream_mode <> 'images'
          `)
        : { rows: [{ count: "0" }] };
    const incompatibleApiProtocolCount = parseCount(
      incompatibleApiProtocolResult.rows[0]?.count,
      "incompatible legacy API protocols"
    );
    const adobeConfigColumnResult = await client.query(`
      select count(*)::integer as count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'image_backend_adobe'
        and column_name in ('mode', 'base_url', 'enabled_models')
    `);
    const invalidAdobeConfigResult =
      adobeConfigColumnResult.rows[0]?.count === 3
        ? await client.query(`
            select count(*)::text as count
            from image_backend_adobe
            where case
              when mode not in ('gateway', 'direct') then true
              when mode = 'gateway' and nullif(btrim(base_url), '') is null
                then true
              when enabled_models is null then false
              when json_typeof(enabled_models) <> 'array' then true
              when json_array_length(enabled_models) > 200 then true
              else exists (
                select 1
                from json_array_elements(enabled_models) as model(value)
                where json_typeof(model.value) <> 'string'
                  or char_length(btrim(model.value #>> '{}')) not between 1 and 120
                  or (
                    image_backend_adobe.mode = 'gateway'
                    and lower(btrim(model.value #>> '{}')) ~
                      '^(firefly-sora2(-pro)?-(4|8|12)s-(9x16|16x9)|(firefly-)?veo31(-ref|-fast)?-(4|6|8)s-(16x9|9x16)-(1080p|720p)|(firefly-)?kling-o3-(5|15)s-(16x9|9x16)|(firefly-)?kling3-(5|10|15)s-(16x9|9x16))$'
                  )
              )
            end
          `)
        : { rows: [{ count: "0" }] };
    const invalidAdobeConfigCount = parseCount(
      invalidAdobeConfigResult.rows[0]?.count,
      "invalid legacy Adobe configs"
    );
    const memberStateColumnResult = await client.query(`
      select
        count(*) filter (
          where table_name = 'image_backend_api'
            and column_name in (
              'status',
              'priority',
              'concurrency',
              'success_count',
              'fail_count',
              'parameter_mappings'
            )
        )::integer as api_count,
        count(*) filter (
          where table_name = 'image_backend_adobe'
            and column_name in (
              'status',
              'priority',
              'concurrency',
              'success_count',
              'fail_count',
              'gpt_image_quality'
            )
        )::integer as adobe_count
      from information_schema.columns
      where table_schema = 'public'
        and table_name in ('image_backend_api', 'image_backend_adobe')
    `);
    const memberStateColumns = memberStateColumnResult.rows[0] ?? {};
    const invalidMemberStateResult =
      memberStateColumns.api_count === 6 && memberStateColumns.adobe_count === 6
        ? await client.query(`
            select sum(invalid_count)::text as count
            from (
              select count(*) as invalid_count
              from image_backend_api
              where status not in ('active', 'limited', 'error')
                or priority < 0
                or priority > 10000
                or concurrency < 1
                or concurrency > 10000
                or success_count < 0
                or fail_count < 0
                or json_typeof(parameter_mappings) <> 'array'
              union all
              select count(*) as invalid_count
              from image_backend_adobe
              where status not in ('active', 'limited', 'error')
                or priority < 0
                or priority > 10000
                or concurrency < 1
                or concurrency > 10000
                or success_count < 0
                or fail_count < 0
                or gpt_image_quality not in ('low', 'medium', 'high')
            ) as invalid_member_state
          `)
        : { rows: [{ count: "0" }] };
    const invalidMemberStateCount = parseCount(
      invalidMemberStateResult.rows[0]?.count,
      "invalid legacy member state"
    );
    const directCredentialTablesPresent =
      presentTables.has("image_backend_adobe") &&
      presentTables.has("adobe_account") &&
      presentTables.has("adobe_token");
    const invalidDirectCredentialResult = directCredentialTablesPresent
      ? await client.query(`
          select count(*)::text as count
          from image_backend_adobe as adobe
          where (
              adobe.mode = 'gateway'
              and (
                exists (
                  select 1 from adobe_account as account
                  where account.adobe_id = adobe.id
                )
                or exists (
                  select 1 from adobe_token as token
                  where token.adobe_id = adobe.id
                )
              )
            ) or (
              adobe.mode = 'direct'
              and (
                not exists (
                  select 1 from adobe_account as account
                  where account.adobe_id = adobe.id
                )
                or exists (
                  select 1
                  from adobe_account as account
                  where account.adobe_id = adobe.id
                    and (
                      account.status not in ('active', 'error', 'disabled')
                      or char_length(btrim(account.cookie)) not between 1 and 64000
                      or (
                        account.scope is not null
                        and char_length(btrim(account.scope)) not between 1 and 4096
                      )
                      or account.consecutive_failures < 0
                      or (
                        select count(*)
                        from adobe_token as token
                        where token.adobe_id = adobe.id
                          and token.account_id = account.id
                          and token.source = 'auto_refresh'
                      ) <> 1
                    )
                )
                or exists (
                  select 1
                  from adobe_token as token
                  left join adobe_account as account
                    on account.id = token.account_id
                    and account.adobe_id = adobe.id
                  where token.adobe_id = adobe.id
                    and (
                      token.account_id is null
                      or token.source <> 'auto_refresh'
                      or token.status not in (
                        'active',
                        'error',
                        'exhausted',
                        'invalid'
                      )
                      or char_length(btrim(token.value)) < 1
                      or token.fails < 0
                      or account.id is null
                    )
                )
              )
            )
        `)
      : { rows: [{ count: "0" }] };
    const invalidDirectCredentialCount = parseCount(
      invalidDirectCredentialResult.rows[0]?.count,
      "invalid legacy Adobe direct credentials"
    );
    const directMemberIdCollisionResult =
      directCredentialTablesPresent && presentTables.has("image_backend_api")
        ? await client.query(`
          with ranked_direct_accounts as (
            select
              account.id,
              row_number() over (
                partition by account.adobe_id
                order by account.created_at, account.id
              ) as ordinal
            from adobe_account as account
            inner join image_backend_adobe as adobe
              on adobe.id = account.adobe_id
              and adobe.mode = 'direct'
          )
          select count(*)::text as count
          from ranked_direct_accounts as account
          where account.ordinal > 1
            and (
              char_length('adobe-direct:' || account.id) > 128
              or exists (
                select 1 from image_backend_api as api
                where api.id = 'adobe-direct:' || account.id
              )
              or exists (
                select 1 from image_backend_adobe as adobe
                where adobe.id = 'adobe-direct:' || account.id
              )
            )
          `)
        : { rows: [{ count: "0" }] };
    const directMemberIdCollisionCount = parseCount(
      directMemberIdCollisionResult.rows[0]?.count,
      "legacy Adobe direct member ID collisions"
    );
    const blockerTotal =
      (tableCounts.get("image_backend_account") ?? 0) +
      (tableCounts.get("image_backend_account_group") ?? 0) +
      activeLeaseCount +
      activeStickyCount +
      activeVideoCount +
      memberIdCollisionCount +
      invalidApiModelCount +
      incompatibleApiProtocolCount +
      invalidAdobeConfigCount +
      invalidMemberStateCount +
      invalidDirectCredentialCount +
      directMemberIdCollisionCount;

    printEvidence("legacy_media_active_lease_count", activeLeaseCount);
    printEvidence("legacy_media_active_sticky_count", activeStickyCount);
    printEvidence("legacy_media_active_video_count", activeVideoCount);
    printEvidence(
      "legacy_media_member_id_collision_count",
      memberIdCollisionCount
    );
    printEvidence("legacy_media_invalid_api_model_count", invalidApiModelCount);
    printEvidence(
      "legacy_media_incompatible_api_protocol_count",
      incompatibleApiProtocolCount
    );
    printEvidence(
      "legacy_media_invalid_adobe_config_count",
      invalidAdobeConfigCount
    );
    printEvidence(
      "legacy_media_invalid_member_state_count",
      invalidMemberStateCount
    );
    printEvidence(
      "legacy_media_invalid_direct_credential_count",
      invalidDirectCredentialCount
    );
    printEvidence(
      "legacy_media_direct_member_id_collision_count",
      directMemberIdCollisionCount
    );
    printEvidence("legacy_media_blocker_total_count", blockerTotal);
    if (blockerTotal !== 0) {
      throw new Error(
        `unified media preflight failed: ${blockerTotal} non-migratable rows found`
      );
    }
  });
}

/** 验证 0060-0064 后统一号池、视频恢复身份和 API Key 配额不变量。 */
async function assertMediaPostMigrationState(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const result = await client.query(
      `
        select
          (
            select count(*)::text
            from unnest($1::text[]) as required(table_name)
            where to_regclass(format('public.%I', table_name)) is not null
          ) as required_table_count,
          (
            select count(*)::text
            from unnest($2::text[]) as legacy(table_name)
            where to_regclass(format('public.%I', table_name)) is not null
          ) as legacy_table_count,
          (
            select count(*)::text
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'video_generation'
              and column_name in ('adobe_id', 'adobe_token_id')
          ) as old_column_count,
          (
            select count(*)::text
            from information_schema.columns
            where table_schema = 'public'
              and (
                (table_name = 'video_generation'
                  and column_name = 'principal_scope' and is_nullable = 'NO')
                or (table_name = 'video_generation'
                  and column_name = 'api_key_credits_reserved'
                  and is_nullable = 'NO')
                or (table_name = 'video_generation_callback_delivery'
                  and column_name = 'callback_url' and is_nullable = 'NO')
                or (table_name = 'image_backend_member_api_config'
                  and column_name = 'use_stream' and is_nullable = 'NO')
                or (table_name = 'image_backend_member_adobe_config'
                  and column_name in (
                    'cookie',
                    'scope',
                    'access_token',
                    'account_user_id',
                    'display_name',
                    'email',
                    'credential_status',
                    'token_expires_at',
                    'token_fails',
                    'last_refresh_at',
                    'last_refresh_error',
                    'next_refresh_at',
                    'consecutive_failures',
                    'credits_total',
                    'credits_used',
                    'credits_available',
                    'credits_updated_at',
                    'credits_error'
                  ))
              )
          ) as required_column_count,
          (
            select count(*)::text
            from pg_constraint
            where connamespace = 'public'::regnamespace
              and conname in (
              'video_generation_backend_member_id_image_backend_member_id_fk',
              'video_generation_stage_check',
              'video_generation_recovery_counts_check',
              'video_generation_callback_delivery_video_generation_id_video_generation_id_fk',
              'video_callback_delivery_status_check',
              'video_callback_delivery_attempt_count_check',
              'video_generation_principal_scope_check',
              'image_backend_member_adobe_config_credential_shape_check',
              'image_backend_member_adobe_config_credential_status_check',
              'image_backend_member_adobe_config_failure_counts_check'
            )
          ) as required_constraint_count,
          (
            select count(*)::text
            from pg_constraint
            where connamespace = 'public'::regnamespace
              and conname =
                'video_generation_member_lease_id_image_backend_member_lease_id_fk'
          ) as recovery_lease_fk_count,
          (
            select count(*)::text
            from pg_indexes
            where schemaname = 'public'
              and indexname in (
                'image_backend_member_eligibility_idx',
                'image_backend_member_cooldown_idx',
                'image_backend_member_group_member_group_unique',
                'image_backend_member_group_group_idx',
                'image_backend_member_lease_member_expires_idx',
                'image_backend_member_lease_expires_idx',
                'image_backend_member_scheduler_metric_bucket_unique',
                'image_backend_member_scheduler_metric_bucket_idx',
                'video_generation_principal_stage_idx',
                'video_generation_recovery_idx',
                'video_callback_delivery_video_unique',
                'video_callback_delivery_recovery_idx'
              )
          ) as required_index_count,
          (
            select count(*)::text
            from system_setting
            where key = any($3::text[])
          ) as removed_setting_count,
          (
            select count(*)::text
            from system_setting
            where key = $4
              and (
                value::jsonb ? 'billing'
                or exists (
                  select 1
                  from jsonb_object_keys(
                    coalesce(value::jsonb -> 'features', '{}'::jsonb)
                  ) as feature(key)
                  where feature.key = any($5::text[])
                )
                or exists (
                  select 1
                  from jsonb_each(
                    coalesce(value::jsonb -> 'limits', '{}'::jsonb)
                  ) as plan(plan_name, limits)
                  cross join lateral jsonb_object_keys(
                    case
                      when jsonb_typeof(plan.limits) = 'object'
                        then plan.limits
                      else '{}'::jsonb
                    end
                  ) as limit_key(key)
                  where limit_key.key = any($6::text[])
                )
              )
          ) as obsolete_plan_count
      `,
      [
        REQUIRED_MEDIA_TABLES,
        LEGACY_MEDIA_TABLES,
        REMOVED_MEDIA_SETTING_KEYS,
        PLAN_MATRIX_SETTING_KEY,
        REMOVED_PLAN_FEATURES,
        REMOVED_PLAN_LIMITS,
      ]
    );
    const row = result.rows[0] ?? {};
    const requiredTableCount = parseCount(
      row.required_table_count,
      "required media tables"
    );
    const legacyTableCount = parseCount(
      row.legacy_table_count,
      "legacy media tables"
    );
    const oldColumnCount = parseCount(
      row.old_column_count,
      "old media columns"
    );
    const requiredColumnCount = parseCount(
      row.required_column_count,
      "required media columns"
    );
    const requiredConstraintCount = parseCount(
      row.required_constraint_count,
      "required media constraints"
    );
    const requiredIndexCount = parseCount(
      row.required_index_count,
      "required media indexes"
    );
    const recoveryLeaseForeignKeyCount = parseCount(
      row.recovery_lease_fk_count,
      "video recovery lease foreign key"
    );
    const removedSettingCount = parseCount(
      row.removed_setting_count,
      "removed media settings"
    );
    const obsoletePlanCount = parseCount(
      row.obsolete_plan_count,
      "obsolete media plan nodes"
    );

    printEvidence("required_media_table_count", requiredTableCount);
    printEvidence("legacy_media_table_count", legacyTableCount);
    printEvidence("old_media_column_count", oldColumnCount);
    printEvidence("required_media_column_count", requiredColumnCount);
    printEvidence("required_media_constraint_count", requiredConstraintCount);
    printEvidence(
      "video_recovery_lease_foreign_key_count",
      recoveryLeaseForeignKeyCount
    );
    printEvidence("required_media_index_count", requiredIndexCount);
    printEvidence("removed_media_setting_count", removedSettingCount);
    printEvidence("obsolete_media_plan_count", obsoletePlanCount);

    if (
      requiredTableCount !== REQUIRED_MEDIA_TABLES.length ||
      legacyTableCount !== 0 ||
      oldColumnCount !== 0 ||
      requiredColumnCount !== 22 ||
      requiredConstraintCount !== 10 ||
      recoveryLeaseForeignKeyCount !== 0 ||
      requiredIndexCount !== 12 ||
      removedSettingCount !== 0 ||
      obsoletePlanCount !== 0
    ) {
      throw new Error("post-migration unified media invariants failed");
    }
  });
}

/**
 * 验证 0056 的 schema、策略、套餐 JSON 与审计索引不变量。
 * 首次删除旧列时额外要求所有管理员覆盖为空，后续发布允许合法覆盖继续存在。
 *
 * @param {pg.Pool} pool 已配置到目标生产数据库的连接池。
 * @param {boolean} requireEmptyOverrides 是否要求所有用户覆盖均为空。
 * @returns {Promise<void>} 全部迁移后不变量满足时完成的 Promise。
 * @throws 查询失败、计数非法，或任一治理不变量不满足时抛错。
 * @sideEffect 在只读事务中查询 schema、设置与索引，并向 stdout 输出聚合证据。
 * @boundary 首次发布拒绝任何非空覆盖；后续发布只允许受 CHECK 约束保护的合法覆盖。
 */
async function assertPostMigrationState(pool, requireEmptyOverrides) {
  await inReadOnlyTransaction(pool, async (client) => {
    const result = await client.query(
      `
        select
          (
            select count(*)::text
            from information_schema.columns
            where table_schema = 'public'
              and (
                (table_name = 'user'
                  and column_name = 'moderation_block_risk_level')
                or (
                  table_name = 'external_api_key'
                  and column_name in (
                    'moderation_block_risk_level',
                    'relay_only'
                  )
                )
              )
          ) as old_column_count,
          (
            select count(*)::text
            from "user"
            where moderation_block_risk_level_override is not null
              and moderation_block_risk_level_override not in (
                'low',
                'medium',
                'high'
              )
          ) as invalid_override_count,
          (
            select count(*)::text
            from "user"
            where moderation_block_risk_level_override is not null
          ) as non_null_override_count,
          (
            select count(*)::text
            from system_setting
            where key = $1
              and json_typeof(value) = 'string'
              and value #>> '{}' in ('low', 'medium', 'high')
          ) as valid_global_count,
          (
            select count(*)::text
            from system_setting
            where key = $2
              and (
                value::jsonb ? 'moderation'
                or coalesce(
                  (value::jsonb -> 'features') ? 'externalApi.relay',
                  false
                )
              )
          ) as obsolete_plan_count,
          (
            select count(*)::text
            from pg_indexes
            where schemaname = 'public'
              and indexname in (
                'admin_audit_log_action_created_at_idx',
                'admin_audit_log_target_user_id_created_at_idx'
              )
          ) as audit_index_count,
          exists (
            select 1
            from information_schema.columns
            where table_schema = 'public'
              and table_name = 'user'
              and column_name = 'moderation_block_risk_level_override'
              and is_nullable = 'YES'
          ) as override_column_valid,
          exists (
            select 1
            from pg_constraint
            where conrelid = 'public.user'::regclass
              and conname =
                'user_moderation_block_risk_level_override_check'
          ) as override_check_present
      `,
      [GLOBAL_SETTING_KEY, PLAN_MATRIX_SETTING_KEY]
    );
    const row = result.rows[0] ?? {};
    const oldColumnCount = parseCount(
      row.old_column_count,
      "old governance columns"
    );
    const invalidOverrideCount = parseCount(
      row.invalid_override_count,
      "invalid user moderation overrides"
    );
    const nonNullOverrideCount = parseCount(
      row.non_null_override_count,
      "non-null user moderation overrides"
    );
    const validGlobalCount = parseCount(
      row.valid_global_count,
      "global moderation policy"
    );
    const obsoletePlanCount = parseCount(
      row.obsolete_plan_count,
      "obsolete plan governance fields"
    );
    const auditIndexCount = parseCount(
      row.audit_index_count,
      "moderation audit indexes"
    );

    printEvidence("old_governance_column_count", oldColumnCount);
    printEvidence("invalid_user_override_count", invalidOverrideCount);
    printEvidence("non_null_user_override_count", nonNullOverrideCount);
    printEvidence("valid_global_policy_count", validGlobalCount);
    printEvidence("obsolete_plan_node_count", obsoletePlanCount);
    printEvidence("moderation_audit_index_count", auditIndexCount);
    printEvidence("override_column_valid", row.override_column_valid === true);
    printEvidence(
      "override_check_present",
      row.override_check_present === true
    );

    if (
      oldColumnCount !== 0 ||
      invalidOverrideCount !== 0 ||
      validGlobalCount !== 1 ||
      obsoletePlanCount !== 0 ||
      auditIndexCount !== 2 ||
      row.override_column_valid !== true ||
      row.override_check_present !== true ||
      (requireEmptyOverrides && nonNullOverrideCount !== 0)
    ) {
      throw new Error("post-migration governance invariants failed");
    }
  });
}

/**
 * 从进程环境和命令行解析命令，并执行唯一对应的只读门禁。
 *
 * @returns {Promise<void>} 指定门禁成功且连接池关闭后完成的 Promise。
 * @throws DATABASE_URL 缺失、命令不支持、连接失败或门禁拒绝时抛错。
 * @sideEffect 读取 process.env/argv，创建并关闭 PostgreSQL 连接池，输出门禁证据。
 * @boundary 只接受 drain、preflight、postcheck 与 postcheck-initial；忽略 pnpm
 *   透传产生的独立 `--` 参数，不输出连接串。
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const command = process.argv.slice(2).find((argument) => argument !== "--");
  const pool = new Pool({
    application_name: "fluxmedia-release-gate",
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5_000,
    max: 1,
    query_timeout: 15_000,
  });
  try {
    if (command === "drain") {
      await assertWebConnectionsDrained(pool);
      return;
    }
    if (command === "preflight") {
      await assertRelayPreflight(pool);
      await assertMediaPreflight(pool);
      return;
    }
    if (command === "postcheck" || command === "postcheck-initial") {
      await assertPostMigrationState(pool, command === "postcheck-initial");
      await assertMediaPostMigrationState(pool);
      return;
    }
    throw new Error(
      "expected one of: drain, preflight, postcheck, postcheck-initial"
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`release governance gate failed: ${message}\n`);
  process.exitCode = 1;
});
