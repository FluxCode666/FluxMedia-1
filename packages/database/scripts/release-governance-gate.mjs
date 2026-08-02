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
const VIDEO_INPUT_MAX_COUNT = 256;
const VIDEO_INPUT_MAX_BYTES = 200 * 1024 * 1024;
const VIDEO_GATE_PAGE_SIZE = 200;
const REAL_VIDEO_MODEL_IDS = [
  "sora2",
  "sora2-pro",
  "veo31",
  "veo31-fast",
  "veo31-ref",
  "kling-o3",
  "kling3",
  "kling3-omni",
  "runway-gen45",
  "ray314",
  "ray314-hdr",
  "seedance2",
  "seedance2-fast",
];
const FROZEN_VIDEO_FAMILIES = [
  {
    model: "sora2",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    model: "sora2-pro",
    durations: [4, 8, 12],
    aspectRatios: ["9:16", "16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    model: "veo31",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "veo31-fast",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "veo31-ref",
    durations: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "kling-o3",
    durations: [5, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p"],
    resolutionInId: false,
  },
  {
    model: "kling3",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "kling3-omni",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "runway-gen45",
    durations: [5, 8, 10],
    aspectRatios: ["16:9"],
    resolutions: ["720p"],
    resolutionInId: false,
  },
  {
    model: "ray314",
    durations: [5, 10],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "ray314-hdr",
    durations: [5],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["4k", "1080p", "720p"],
    resolutionInId: true,
  },
  {
    model: "seedance2",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["1080p", "720p", "480p"],
    resolutionInId: true,
  },
  {
    model: "seedance2-fast",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    resolutions: ["720p", "480p"],
    resolutionInId: true,
  },
];

/**
 * 构造与 0074 SQL 独立冻结的复合模型映射。
 *
 * @returns 573 个规范组合与 6 个 Kling 历史别名。
 * @throws 冻结规格计数漂移时抛错并阻止发布门禁启动。
 * @sideEffect 无副作用。
 * @boundary 不读取运行时模型目录，避免未来目录变化改写历史。
 */
function buildFrozenVideoModelMapping() {
  const mapping = new Map();
  let canonicalCount = 0;
  for (const family of FROZEN_VIDEO_FAMILIES) {
    for (const duration of family.durations) {
      for (const aspectRatio of family.aspectRatios) {
        for (const resolution of family.resolutions) {
          const ratioSuffix = aspectRatio.replace(":", "x");
          const resolutionSuffix = family.resolutionInId
            ? `-${resolution}`
            : "";
          mapping.set(
            `${family.model}-${duration}s-${ratioSuffix}${resolutionSuffix}`,
            {
              model: family.model,
              duration,
              aspectRatio,
              resolution,
            }
          );
          canonicalCount += 1;
        }
      }
    }
  }
  let aliasCount = 0;
  for (const duration of [5, 10, 15]) {
    for (const aspectRatio of ["16:9", "9:16"]) {
      mapping.set(`kling3-${duration}s-${aspectRatio.replace(":", "x")}`, {
        model: "kling3",
        duration,
        aspectRatio,
        resolution: "720p",
      });
      aliasCount += 1;
    }
  }
  if (
    canonicalCount !== 573 ||
    aliasCount !== 6 ||
    mapping.size !== canonicalCount + aliasCount
  ) {
    throw new Error("frozen video request migration mapping is incomplete");
  }
  return mapping;
}

const FROZEN_VIDEO_MODEL_MAPPING = buildFrozenVideoModelMapping();
const REAL_VIDEO_MODEL_SET = new Set(REAL_VIDEO_MODEL_IDS);
const VIDEO_FAMILY_BY_ID = new Map(
  FROZEN_VIDEO_FAMILIES.map((family) => [family.model, family])
);

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
      const legacySubpoolTableResult = await client.query(`
        select
          to_regclass('public.adobe_account') is not null as account_present,
          to_regclass('public.adobe_token') is not null as token_present
      `);
      const legacySubpoolTables = legacySubpoolTableResult.rows[0] ?? {};
      const accountPresent = legacySubpoolTables.account_present === true;
      const tokenPresent = legacySubpoolTables.token_present === true;
      if (accountPresent !== tokenPresent) {
        throw new Error(
          "unified media preflight failed: legacy Adobe subpool is incomplete"
        );
      }

      if (!accountPresent) {
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

      const legacySubpoolResult = await client.query(`
        select
          (select count(*)::text from adobe_account) as account_count,
          (select count(*)::text from adobe_token) as token_count,
          (
            select count(*)::text
            from video_generation
            where adobe_token_id is not null
          ) as video_reference_count,
          (
            select count(*)::text
            from image_backend_member_lease as lease
            inner join image_backend_member_adobe_config as adobe
              on adobe.member_id = lease.member_id
              and adobe.mode = 'direct'
            where lease.expires_at > now()
          ) as active_lease_count,
          (
            select count(*)::text
            from video_generation as video
            inner join image_backend_member_adobe_config as adobe
              on adobe.member_id = video.backend_member_id
              and adobe.mode = 'direct'
            where video.stage not in ('completed', 'failed')
          ) as active_video_count,
          (
            select count(*)::text
            from image_backend_member_adobe_config as adobe
            where (
                adobe.mode = 'gateway'
                and (
                  exists (
                    select 1
                    from adobe_account as account
                    where account.member_id = adobe.member_id
                  )
                  or exists (
                    select 1
                    from adobe_token as token
                    where token.member_id = adobe.member_id
                  )
                )
              ) or (
                adobe.mode = 'direct'
                and (
                  not exists (
                    select 1
                    from adobe_account as account
                    where account.member_id = adobe.member_id
                  )
                  or exists (
                    select 1
                    from adobe_account as account
                    where account.member_id = adobe.member_id
                      and (
                        account.status not in ('active', 'error', 'disabled')
                        or char_length(btrim(account.cookie))
                          not between 1 and 64000
                        or (
                          account.scope is not null
                          and char_length(btrim(account.scope))
                            not between 1 and 4096
                        )
                        or account.consecutive_failures < 0
                        or (
                          select count(*)
                          from adobe_token as token
                          where token.member_id = adobe.member_id
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
                      and account.member_id = adobe.member_id
                    where token.member_id = adobe.member_id
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
          ) as invalid_direct_credential_count,
          (
            with ranked_direct_accounts as (
              select
                account.id,
                row_number() over (
                  partition by account.member_id
                  order by account.created_at, account.id
                ) as ordinal
              from adobe_account as account
              inner join image_backend_member_adobe_config as adobe
                on adobe.member_id = account.member_id
                and adobe.mode = 'direct'
            )
            select count(*)::text
            from ranked_direct_accounts as account
            where account.ordinal > 1
              and (
                char_length('adobe-direct:' || account.id) > 128
                or exists (
                  select 1
                  from image_backend_member as member
                  where member.id = 'adobe-direct:' || account.id
                )
              )
          ) as direct_member_id_collision_count
      `);
      const legacySubpool = legacySubpoolResult.rows[0] ?? {};
      const accountCount = parseCount(
        legacySubpool.account_count,
        "legacy unified Adobe accounts"
      );
      const tokenCount = parseCount(
        legacySubpool.token_count,
        "legacy unified Adobe tokens"
      );
      const videoReferenceCount = parseCount(
        legacySubpool.video_reference_count,
        "legacy unified Adobe video token references"
      );
      const activeLeaseCount = parseCount(
        legacySubpool.active_lease_count,
        "legacy unified Adobe active leases"
      );
      const activeVideoCount = parseCount(
        legacySubpool.active_video_count,
        "legacy unified Adobe active videos"
      );
      const invalidDirectCredentialCount = parseCount(
        legacySubpool.invalid_direct_credential_count,
        "legacy unified Adobe direct credentials"
      );
      const directMemberIdCollisionCount = parseCount(
        legacySubpool.direct_member_id_collision_count,
        "legacy unified Adobe member ID collisions"
      );
      for (const tableName of LEGACY_MEDIA_TABLES) {
        const count =
          tableName === "adobe_account"
            ? accountCount
            : tableName === "adobe_token"
              ? tokenCount
              : 0;
        printEvidence(`legacy_media_${tableName}_count`, count);
      }
      printEvidence(
        "legacy_media_video_adobe_reference_count",
        videoReferenceCount
      );
      printEvidence(
        "legacy_media_total_count",
        accountCount + tokenCount + videoReferenceCount
      );
      printEvidence("legacy_media_active_lease_count", activeLeaseCount);
      printEvidence("legacy_media_active_sticky_count", 0);
      printEvidence("legacy_media_active_video_count", activeVideoCount);
      printEvidence("legacy_media_member_id_collision_count", 0);
      printEvidence("legacy_media_invalid_api_model_count", 0);
      printEvidence("legacy_media_incompatible_api_protocol_count", 0);
      printEvidence("legacy_media_invalid_adobe_config_count", 0);
      printEvidence("legacy_media_invalid_member_state_count", 0);
      printEvidence(
        "legacy_media_invalid_direct_credential_count",
        invalidDirectCredentialCount
      );
      printEvidence(
        "legacy_media_direct_member_id_collision_count",
        directMemberIdCollisionCount
      );
      const blockerTotal =
        activeLeaseCount +
        activeVideoCount +
        invalidDirectCredentialCount +
        directMemberIdCollisionCount;
      printEvidence("legacy_media_blocker_total_count", blockerTotal);
      if (blockerTotal !== 0) {
        throw new Error(
          `unified media preflight failed: ${blockerTotal} non-migratable legacy Adobe rows found`
        );
      }
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

/** 将不可信 JSON 值收窄为普通对象。 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断模型值是否属于冻结视频命名空间。 */
function looksLikeVideoModel(modelId) {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized.startsWith("firefly-") ||
    REAL_VIDEO_MODEL_IDS.some(
      (realModel) =>
        normalized === realModel || normalized.startsWith(`${realModel}-`)
    )
  );
}

/** 解析旧复合或已切换真实模型任务，并证明独立参数完全一致。 */
function resolveFrozenVideoTask(row) {
  if (
    typeof row.model !== "string" ||
    typeof row.family !== "string" ||
    !Number.isSafeInteger(row.duration_seconds) ||
    typeof row.aspect_ratio !== "string" ||
    typeof row.resolution !== "string"
  ) {
    return null;
  }
  const normalizedModel = row.model.trim().toLowerCase();
  const mapped = FROZEN_VIDEO_MODEL_MAPPING.get(normalizedModel);
  const realModel =
    mapped?.model ??
    (REAL_VIDEO_MODEL_SET.has(normalizedModel) ? normalizedModel : null);
  if (!realModel || row.family.trim().toLowerCase() !== realModel) return null;
  const capability = VIDEO_FAMILY_BY_ID.get(realModel);
  if (!capability) return null;
  const durationMatches = mapped
    ? row.duration_seconds === mapped.duration
    : capability.durations.includes(row.duration_seconds);
  const aspectRatio = row.aspect_ratio.trim();
  const resolution = row.resolution.trim().toLowerCase();
  const ratioMatches = mapped
    ? aspectRatio === mapped.aspectRatio
    : capability.aspectRatios.includes(aspectRatio);
  const resolutionMatches = mapped
    ? resolution === mapped.resolution
    : capability.resolutions.includes(resolution);
  if (!durationMatches || !ratioMatches || !resolutionMatches) return null;
  return realModel;
}

/** 判断不可信数据库值是否为可持久恢复的非空文本。 */
function isNonemptyVideoRecoveryText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 按视频阶段验证旧任务恢复身份，阻止切换后才发现任务无法接管或轮询。
 *
 * @param {Record<string, unknown>} row 旧 video_generation 行。
 * @returns {boolean} 状态、Profile 与阶段所需持久身份全部一致时为 true。
 * @sideEffect 无。
 * @boundary upstream_job_id 可为空，因为供应商成功响应允许不返回；next_poll_at
 *   为空会被恢复仓储立即认领，不属于身份缺失。
 */
function validateLegacyVideoRecoveryIdentity(row) {
  if (
    !["express", "firefly"].includes(row.adobe_request_profile) ||
    !["express", "firefly"].includes(row.adobe_auth_profile)
  ) {
    return false;
  }
  const hasMember = isNonemptyVideoRecoveryText(row.backend_member_id);
  const hasLease =
    hasMember &&
    isNonemptyVideoRecoveryText(row.member_lease_id) &&
    isNonemptyVideoRecoveryText(row.member_lease_owner_token);
  if (row.stage === "created") return row.status === "pending";
  if (row.stage === "charged") return row.status === "running" && hasLease;
  if (row.stage === "submitting") {
    return (
      row.status === "running" &&
      hasLease &&
      row.submit_started_at instanceof Date
    );
  }
  if (row.stage === "submit_uncertain") {
    return row.status === "running" && hasMember;
  }
  if (row.stage === "polling") {
    return (
      row.status === "running" &&
      hasLease &&
      isNonemptyVideoRecoveryText(row.poll_url) &&
      row.upstream_accepted_at instanceof Date
    );
  }
  if (row.stage === "downloading") {
    return (
      row.status === "running" &&
      hasLease &&
      isNonemptyVideoRecoveryText(row.video_url) &&
      isNonemptyVideoRecoveryText(row.storage_key)
    );
  }
  if (row.stage === "refunding") return row.status === "running";
  if (row.stage === "completed") return row.status === "completed";
  if (row.stage === "failed") return row.status === "failed";
  return false;
}

/** 验证单个任务自有 storage 输入，不输出其对象身份。 */
function validateVideoInputReference(reference, row, seenStorageKeys) {
  if (!isRecord(reference)) return null;
  const allowedKeys = new Set([
    "source",
    "mimeType",
    "storageKey",
    "storageBucket",
    "byteLength",
  ]);
  if (Object.keys(reference).some((key) => !allowedKeys.has(key))) return null;
  if (
    reference.source !== "storage" ||
    !["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType) ||
    typeof reference.storageKey !== "string" ||
    typeof reference.storageBucket !== "string" ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength <= 0 ||
    reference.byteLength > VIDEO_INPUT_MAX_BYTES
  ) {
    return null;
  }
  const storageKey = reference.storageKey;
  const storageBucket = reference.storageBucket;
  const prefix = `${row.user_id}/video-inputs/${row.id}/`;
  const suffix = storageKey.startsWith(prefix)
    ? storageKey.slice(prefix.length).split("/")
    : [];
  if (
    storageKey !== storageKey.trim() ||
    storageKey.length > 1_024 ||
    suffix.length !== 2 ||
    suffix.some((segment) => !segment || segment === "." || segment === "..") ||
    storageBucket !== storageBucket.trim() ||
    storageBucket.length === 0 ||
    storageBucket.length > 128 ||
    storageBucket.includes("/") ||
    storageBucket.includes("\\") ||
    storageBucket.includes("..") ||
    seenStorageKeys.has(storageKey)
  ) {
    return null;
  }
  seenStorageKeys.add(storageKey);
  return reference.byteLength;
}

/** 按真实模型能力验证具名输入清单和任务对象归属。 */
function validateVideoInputManifest(manifest, row, realModel) {
  if (!isRecord(manifest) || Object.keys(manifest).length === 0) return false;
  const allowedKeys = new Set(["firstFrame", "lastFrame", "referenceImages"]);
  if (Object.keys(manifest).some((key) => !allowedKeys.has(key))) return false;
  const hasFirst = manifest.firstFrame !== undefined;
  const hasLast = manifest.lastFrame !== undefined;
  const hasReferences = manifest.referenceImages !== undefined;
  if ((hasLast && !hasFirst) || ((hasFirst || hasLast) && hasReferences)) {
    return false;
  }
  if (
    hasReferences &&
    (!Array.isArray(manifest.referenceImages) ||
      manifest.referenceImages.length === 0)
  ) {
    return false;
  }
  const references = [
    ...(hasFirst ? [manifest.firstFrame] : []),
    ...(hasLast ? [manifest.lastFrame] : []),
    ...(Array.isArray(manifest.referenceImages)
      ? manifest.referenceImages
      : []),
  ];
  if (references.length === 0 || references.length > VIDEO_INPUT_MAX_COUNT) {
    return false;
  }
  const frameCount = Number(hasFirst) + Number(hasLast);
  const referenceCount = Array.isArray(manifest.referenceImages)
    ? manifest.referenceImages.length
    : 0;
  const framesOnly = frameCount >= 1 && referenceCount === 0;
  const referencesOnly = frameCount === 0 && referenceCount >= 1;
  const modeValid =
    ((realModel === "sora2" || realModel === "sora2-pro") &&
      frameCount === 1 &&
      referencesOnly === false) ||
    (["veo31", "veo31-fast", "kling-o3", "kling3"].includes(realModel) &&
      framesOnly &&
      frameCount <= 2) ||
    (realModel === "veo31-ref" && referencesOnly && referenceCount <= 3) ||
    (realModel === "kling3-omni" &&
      ((framesOnly && frameCount <= 2) ||
        (referencesOnly && referenceCount <= 3))) ||
    (["seedance2", "seedance2-fast"].includes(realModel) &&
      ((framesOnly && frameCount <= 2) || referencesOnly));
  if (!modeValid) return false;
  const seenStorageKeys = new Set();
  let totalBytes = 0;
  for (const reference of references) {
    const byteLength = validateVideoInputReference(
      reference,
      row,
      seenStorageKeys
    );
    if (byteLength === null) return false;
    totalBytes += byteLength;
    if (totalBytes > VIDEO_INPUT_MAX_BYTES) return false;
  }
  return true;
}

/** 将旧数组与可证明角色投影为具名输入清单。 */
function projectLegacyVideoInputManifest(row, realModel) {
  if (row.input_manifest !== null && row.input_image_refs !== null) return null;
  if (row.input_manifest !== null) {
    return validateVideoInputManifest(row.input_manifest, row, realModel)
      ? row.input_manifest
      : null;
  }
  if (row.input_image_refs === null) {
    return (row.metadata === null || isRecord(row.metadata)) &&
      row.metadata?.inputImageRole === undefined
      ? undefined
      : null;
  }
  if (
    !Array.isArray(row.input_image_refs) ||
    row.input_image_refs.length === 0 ||
    !isRecord(row.metadata)
  ) {
    return null;
  }
  const role = row.metadata.inputImageRole;
  let manifest;
  if (role === "reference") {
    manifest = { referenceImages: row.input_image_refs };
  } else if (role === "frame" && row.input_image_refs.length === 1) {
    manifest = { firstFrame: row.input_image_refs[0] };
  } else if (role === "frame" && row.input_image_refs.length === 2) {
    manifest = {
      firstFrame: row.input_image_refs[0],
      lastFrame: row.input_image_refs[1],
    };
  } else {
    return null;
  }
  return validateVideoInputManifest(manifest, row, realModel) ? manifest : null;
}

/** 记录不超过 20 个非敏感记录 ID，同时保留完整阻断计数。 */
function addVideoGateBlocker(blockers, id) {
  blockers.count += 1;
  if (blockers.ids.length < 20) blockers.ids.push(id);
}

/**
 * 将阻断 ID 编码为单行 JSON，避免数据库主键中的换行污染发布证据边界。
 *
 * @param {string[]} ids 最多 20 个非敏感记录 ID。
 * @returns {string} 不含实际 Unicode 行分隔符的 JSON 数组。
 * @throws JSON 序列化失败时原样抛错；字符串数组不会触发该失败模式。
 * @sideEffect 无。
 * @boundary U+2028/U+2029 需额外转义，因为 JSON.stringify 默认会保留它们。
 */
function serializeVideoGateBlockerIds(ids) {
  return JSON.stringify(ids)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** 输出视频契约门禁的非敏感计数与记录 ID，并在存在阻断项时拒绝。 */
function assertNoVideoGateBlockers(blockers) {
  printEvidence("video_contract_blocker_count", blockers.count);
  printEvidence(
    "video_contract_blocker_ids",
    serializeVideoGateBlockerIds(blockers.ids)
  );
  if (blockers.count !== 0) {
    throw new Error(
      `video request contract preflight failed: ${blockers.count} records blocked`
    );
  }
}

/** 在 0074 前证明成员、任务、输入角色和任务对象都可唯一迁移。 */
async function assertVideoContractPreflight(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const schemaResult = await client.query(`
      select
        count(*) filter (
          where column_name in (
            'family', 'input_image_refs', 'staged_input_objects'
          )
        )::text as legacy_column_count,
        count(*) filter (
          where column_name = 'input_manifest'
        )::text as manifest_column_count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'video_generation'
    `);
    const schema = schemaResult.rows[0] ?? {};
    const legacyColumnCount = parseCount(
      schema.legacy_column_count,
      "video contract legacy columns"
    );
    const manifestColumnCount = parseCount(
      schema.manifest_column_count,
      "video contract manifest columns"
    );
    printEvidence("video_contract_legacy_column_count", legacyColumnCount);
    printEvidence("video_contract_manifest_column_count", manifestColumnCount);
    if (legacyColumnCount === 0 && manifestColumnCount === 1) {
      printEvidence("video_contract_schema_state", "applied");
      printEvidence("video_contract_blocker_count", 0);
      printEvidence("video_contract_blocker_ids", "[]");
      return;
    }
    if (legacyColumnCount !== 3 || manifestColumnCount !== 0) {
      throw new Error("video request contract preflight found partial schema");
    }
    printEvidence("video_contract_schema_state", "legacy");
    const blockers = { count: 0, ids: [] };
    let afterMemberId = null;
    while (true) {
      const members = await client.query(
        `select member.id, member.type, member.supported_model_ids, adobe.mode
         from image_backend_member as member
         left join image_backend_member_adobe_config as adobe
           on adobe.member_id = member.id
         where ($1::text is null or member.id > $1)
         order by member.id
         limit $2`,
        [afterMemberId, VIDEO_GATE_PAGE_SIZE]
      );
      if (members.rows.length === 0) break;
      for (const member of members.rows) {
        if (
          !Array.isArray(member.supported_model_ids) ||
          member.supported_model_ids.length === 0 ||
          member.supported_model_ids.length > 1000
        ) {
          addVideoGateBlocker(blockers, `member:${member.id}`);
          continue;
        }
        const seenProjectedModels = new Set();
        let invalid = false;
        for (const value of member.supported_model_ids) {
          if (
            typeof value !== "string" ||
            value.trim().length === 0 ||
            value.trim().length > 120
          ) {
            invalid = true;
            break;
          }
          const normalized = value.trim().toLowerCase();
          const mapping = FROZEN_VIDEO_MODEL_MAPPING.get(normalized);
          const mapped = mapping !== undefined;
          const real = REAL_VIDEO_MODEL_SET.has(normalized);
          if (
            (looksLikeVideoModel(normalized) && !mapped && !real) ||
            ((mapped || real) &&
              (member.type !== "adobe" || member.mode !== "direct"))
          ) {
            invalid = true;
            break;
          }
          const projectedModel = mapping?.model ?? (real ? normalized : value);
          const projectedIdentity = projectedModel.toLowerCase();
          if (seenProjectedModels.has(projectedIdentity)) {
            if (mapped || real) continue;
            invalid = true;
            break;
          }
          if (!mapped && !real && value !== value.trim()) {
            invalid = true;
            break;
          }
          seenProjectedModels.add(projectedIdentity);
        }
        if (invalid) addVideoGateBlocker(blockers, `member:${member.id}`);
      }
      afterMemberId = members.rows.at(-1)?.id ?? null;
    }

    let afterTaskId = null;
    while (true) {
      const tasks = await client.query(
        `select
           id, user_id, model, family, duration_seconds, aspect_ratio,
           resolution, status, stage, metadata, input_image_refs,
           null::json as input_manifest,
           staged_input_objects, backend_member_id, member_lease_id,
           member_lease_owner_token, adobe_request_profile,
           adobe_auth_profile, poll_url, upstream_job_id, next_poll_at,
           submit_started_at, upstream_accepted_at, storage_key, video_url,
           credits_consumed, api_key_credits_reserved
         from video_generation
         where ($1::text is null or id > $1)
         order by id
         limit $2`,
        [afterTaskId, VIDEO_GATE_PAGE_SIZE]
      );
      if (tasks.rows.length === 0) break;
      for (const row of tasks.rows) {
        const realModel = resolveFrozenVideoTask(row);
        const metadataValid = row.metadata === null || isRecord(row.metadata);
        const stagingValid =
          row.staged_input_objects === null ||
          (Array.isArray(row.staged_input_objects) &&
            row.staged_input_objects.length === 0);
        const manifest = realModel
          ? projectLegacyVideoInputManifest(row, realModel)
          : null;
        if (
          !realModel ||
          !metadataValid ||
          !stagingValid ||
          !validateLegacyVideoRecoveryIdentity(row) ||
          manifest === null
        ) {
          addVideoGateBlocker(blockers, `task:${row.id}`);
        }
      }
      afterTaskId = tasks.rows.at(-1)?.id ?? null;
    }
    assertNoVideoGateBlockers(blockers);
  });
}

/** 在停服前只验证视频 schema 处于完整旧版或完整新版，拒绝部分切换。 */
async function assertVideoContractSchemaStage(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const result = await client.query(`
      select
        count(*) filter (
          where column_name in (
            'family', 'input_image_refs', 'staged_input_objects'
          )
        )::text as legacy_column_count,
        count(*) filter (
          where column_name = 'input_manifest'
        )::text as manifest_column_count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'video_generation'
    `);
    const row = result.rows[0] ?? {};
    const legacyColumnCount = parseCount(
      row.legacy_column_count,
      "video contract schema stage legacy columns"
    );
    const manifestColumnCount = parseCount(
      row.manifest_column_count,
      "video contract schema stage manifest column"
    );
    const state =
      legacyColumnCount === 3 && manifestColumnCount === 0
        ? "legacy"
        : legacyColumnCount === 0 && manifestColumnCount === 1
          ? "applied"
          : "partial";
    printEvidence("video_contract_schema_state", state);
    if (state === "partial") {
      throw new Error("video request contract schema is partially migrated");
    }
  });
}

/** 供回滚流程证明旧应用只能在仍含三个旧列的 schema 上启动。 */
async function assertLegacyVideoContractStartupAllowed(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const result = await client.query(`
      select count(*)::text as count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'video_generation'
        and column_name in (
          'family', 'input_image_refs', 'staged_input_objects'
        )
    `);
    const count = parseCount(
      result.rows[0]?.count,
      "legacy video application startup columns"
    );
    printEvidence("legacy_video_contract_column_count", count);
    if (count !== 3) {
      throw new Error(
        "legacy video application cannot start on the real video contract schema"
      );
    }
  });
}

/**
 * 证明 0074-0076 后真实 ID、输入归属与清理队列 schema 均完全收敛。
 *
 * @param {import("pg").Pool} pool 连接目标 PostgreSQL 的连接池。
 * @returns {Promise<void>} 所有视频请求契约均满足时完成的 Promise。
 * @throws 必需列、默认值、非空属性、约束定义或存量数据漂移时抛错。
 * @sideEffect 在只读事务中查询 information_schema、pg_constraint 与业务表。
 * @boundary 精确校验 reason 的默认值、非空与枚举约束，避免运行时 Drizzle
 *   schema 再次领先于已部署数据库。
 */
async function assertVideoContractPostMigrationState(pool) {
  await inReadOnlyTransaction(pool, async (client) => {
    const schemaResult = await client.query(`
      select
        count(*) filter (
          where column_name in (
            'family', 'input_image_refs', 'staged_input_objects'
          )
        )::text as legacy_column_count,
        count(*) filter (
          where column_name = 'input_manifest'
            and is_nullable = 'YES'
        )::text as manifest_column_count,
        (
          select count(*)::text
          from information_schema.columns
          where table_schema = 'public'
            and table_name = 'video_input_cleanup'
            and column_name = 'reason'
            and is_nullable = 'NO'
            and column_default = '''orphan''::text'
        ) as cleanup_reason_column_count
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'video_generation'
    `);
    const schema = schemaResult.rows[0] ?? {};
    const legacyColumnCount = parseCount(
      schema.legacy_column_count,
      "post-migration video legacy columns"
    );
    const manifestColumnCount = parseCount(
      schema.manifest_column_count,
      "post-migration video manifest column"
    );
    const cleanupReasonColumnCount = parseCount(
      schema.cleanup_reason_column_count,
      "post-migration video cleanup reason column"
    );
    printEvidence("video_contract_legacy_column_count", legacyColumnCount);
    printEvidence("video_contract_manifest_column_count", manifestColumnCount);
    printEvidence(
      "video_contract_cleanup_reason_column_count",
      cleanupReasonColumnCount
    );
    if (
      legacyColumnCount !== 0 ||
      manifestColumnCount !== 1 ||
      cleanupReasonColumnCount !== 1
    ) {
      throw new Error("post-migration video request schema invariants failed");
    }
    const result = await client.query(
      `select
         (
           select count(*)::text
           from pg_constraint as constraint_record
           inner join pg_class as relation
             on relation.oid = constraint_record.conrelid
           where relation.relnamespace = 'public'::regnamespace
             and constraint_record.contype = 'c'
             and constraint_record.convalidated
             and (
               (relation.relname = 'image_backend_member'
                 and constraint_record.conname =
                   'image_backend_member_supported_models_check'
                 and pg_get_constraintdef(constraint_record.oid, true) =
                   'CHECK (media_supported_model_ids_are_valid(supported_model_ids))')
               or (relation.relname = 'video_input_cleanup'
                 and constraint_record.conname =
                     'video_input_cleanup_reason_check'
                 and pg_get_constraintdef(constraint_record.oid, true) =
                   'CHECK (reason = ANY (ARRAY[''orphan''::text, ''lifecycle_delete''::text]))')
               or (relation.relname = 'video_generation'
                 and (
                   (constraint_record.conname =
                     'video_generation_input_manifest_check'
                     and pg_get_constraintdef(constraint_record.oid, true) =
                       'CHECK (input_manifest IS NULL OR video_input_manifest_is_valid(input_manifest, user_id, id, model))')
                   or (constraint_record.conname =
                     'video_generation_real_model_check'
                     and pg_get_constraintdef(constraint_record.oid, true) =
                       'CHECK (model = ANY (ARRAY[''sora2''::text, ''sora2-pro''::text, ''veo31''::text, ''veo31-fast''::text, ''veo31-ref''::text, ''kling-o3''::text, ''kling3''::text, ''kling3-omni''::text, ''runway-gen45''::text, ''ray314''::text, ''ray314-hdr''::text, ''seedance2''::text, ''seedance2-fast''::text]))')))
             )
         ) as constraint_count,
         (
           select count(*)::text
           from pg_proc as procedure_record
           where procedure_record.pronamespace = 'public'::regnamespace
             and procedure_record.prorettype = 'boolean'::regtype
             and procedure_record.provolatile = 'i'
             and procedure_record.proisstrict
             and not procedure_record.prosecdef
             and procedure_record.proconfig =
               array['search_path=pg_catalog']::text[]
             and (
               (procedure_record.proname =
                 'media_supported_model_ids_are_valid'
                 and procedure_record.pronargs = 1
                 and procedure_record.proargtypes[0] = 'json'::regtype)
               or (procedure_record.proname =
                 'video_input_manifest_is_valid'
                 and procedure_record.pronargs = 4
                 and procedure_record.proargtypes[0] = 'json'::regtype
                 and procedure_record.proargtypes[1] = 'text'::regtype
                 and procedure_record.proargtypes[2] = 'text'::regtype
                 and procedure_record.proargtypes[3] = 'text'::regtype)
             )
         ) as function_count,
         (
           media_supported_model_ids_are_valid(
             '["seedance2","image-model"]'::json
           )
           and not media_supported_model_ids_are_valid(
             '["seedance2-4s-16x9-1080p"]'::json
           )
           and not media_supported_model_ids_are_valid(
             '["image","IMAGE"]'::json
           )
           and video_input_manifest_is_valid(
             '{"firstFrame":{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/f.png","storageBucket":"b","byteLength":1}}'::json,
             'u', 't', 'seedance2'
           )
           and not video_input_manifest_is_valid(
             '{"firstFrame":{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/f.png","storageBucket":"b","byteLength":1},"referenceImages":[{"source":"storage","mimeType":"image/png","storageKey":"u/video-inputs/t/a/r.png","storageBucket":"b","byteLength":1}]}'::json,
             'u', 't', 'seedance2'
           )
         ) as validator_semantics_valid,
         (
           select count(*)::text
           from video_generation
           where model <> all($1::text[])
         ) as invalid_task_model_count,
         (
           select count(*)::text
           from image_backend_member
           where not media_supported_model_ids_are_valid(
             supported_model_ids
           )
         ) as invalid_member_model_count,
         (
           select count(*)::text
           from video_generation
           where input_manifest is not null
             and not video_input_manifest_is_valid(
               input_manifest, user_id, id, model
             )
         ) as invalid_input_manifest_count`,
      [REAL_VIDEO_MODEL_IDS]
    );
    const row = result.rows[0] ?? {};
    const constraintCount = parseCount(
      row.constraint_count,
      "video contract constraints"
    );
    const functionCount = parseCount(
      row.function_count,
      "video contract functions"
    );
    const validatorSemanticsValid = row.validator_semantics_valid === true;
    const invalidTaskModelCount = parseCount(
      row.invalid_task_model_count,
      "invalid video task models"
    );
    const invalidMemberModelCount = parseCount(
      row.invalid_member_model_count,
      "invalid video member models"
    );
    const invalidInputManifestCount = parseCount(
      row.invalid_input_manifest_count,
      "invalid video input manifests"
    );
    printEvidence("video_contract_constraint_count", constraintCount);
    printEvidence("video_contract_function_count", functionCount);
    printEvidence(
      "video_contract_validator_semantics_valid",
      validatorSemanticsValid
    );
    printEvidence(
      "video_contract_invalid_task_model_count",
      invalidTaskModelCount
    );
    printEvidence(
      "video_contract_invalid_member_model_count",
      invalidMemberModelCount
    );
    printEvidence(
      "video_contract_invalid_input_manifest_count",
      invalidInputManifestCount
    );
    if (
      constraintCount !== 4 ||
      functionCount !== 2 ||
      !validatorSemanticsValid ||
      invalidTaskModelCount !== 0 ||
      invalidMemberModelCount !== 0 ||
      invalidInputManifestCount !== 0
    ) {
      throw new Error("post-migration video request invariants failed");
    }
  });
}

/** 验证 0060-0077 后统一号池、视频恢复身份和 API Key 配额不变量。 */
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
                or (table_name = 'video_generation'
                  and column_name in (
                    'adobe_request_profile',
                    'adobe_auth_profile'
                  )
                  and is_nullable = 'NO')
                or (table_name = 'video_generation_callback_delivery'
                  and column_name = 'callback_url' and is_nullable = 'NO')
                or (table_name = 'image_backend_member_api_config'
                  and column_name in (
                    'current_adapter_version_id',
                    'credential_scope'
                  )
                  and is_nullable = 'NO')
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
                    'firefly_access_token',
                    'firefly_token_expires_at',
                    'firefly_credential_status',
                    'firefly_token_fails',
                    'firefly_last_refresh_at',
                    'firefly_last_refresh_error',
                    'firefly_next_refresh_at',
                    'firefly_consecutive_failures',
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
              'video_generation_adobe_profile_check',
              'image_backend_member_adobe_config_credential_shape_check',
              'image_backend_member_adobe_config_credential_status_check',
              'image_backend_member_adobe_config_firefly_credential_status_check',
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
      requiredColumnCount !== 33 ||
      requiredConstraintCount !== 12 ||
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
 * @boundary 只接受 drain、preflight-early、preflight、postcheck、
 *   postcheck-initial 与 legacy-startup；忽略 pnpm 透传的独立 `--` 参数。
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
    if (command === "preflight-early") {
      await assertRelayPreflight(pool);
      await assertMediaPreflight(pool);
      await assertVideoContractSchemaStage(pool);
      return;
    }
    if (command === "preflight") {
      await assertRelayPreflight(pool);
      await assertMediaPreflight(pool);
      await assertVideoContractPreflight(pool);
      return;
    }
    if (command === "postcheck" || command === "postcheck-initial") {
      await assertPostMigrationState(pool, command === "postcheck-initial");
      await assertMediaPostMigrationState(pool);
      await assertVideoContractPostMigrationState(pool);
      return;
    }
    if (command === "legacy-startup") {
      await assertLegacyVideoContractStartupAllowed(pool);
      return;
    }
    throw new Error(
      "expected one of: drain, preflight-early, preflight, postcheck, postcheck-initial, legacy-startup"
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
