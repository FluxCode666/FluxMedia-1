/**
 * 运营总览浏览器测试的 PostgreSQL 夹具。
 *
 * 使用方：Playwright global setup。夹具只连接显式专用测试库，创建真实 Better Auth
 * credential 账号和稳定导出状态；不会迁移数据库、修改开发账号或伪造会话。
 */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { hashPassword } from "better-auth/crypto";
import { Pool, type PoolClient } from "pg";

import {
  OPERATIONS_E2E_USERS,
  type OperationsE2EEnvironment,
} from "./environment";

const FIXTURE_USER_IDS = Object.values(OPERATIONS_E2E_USERS).map(
  (fixture) => fixture.id
);
const COMPLETED_EXPORT_ID = "operations-e2e-export-completed";
const EXPIRED_EXPORT_ID = "operations-e2e-export-expired";

type FixtureExportObject = {
  bucket: string;
  key: string;
  checksumSha256: string;
  rowCount: number;
  byteCount: number;
};

/** 构造带 UTF-8 BOM、稳定表头和一条真实用户事实的增长导出 CSV。 */
function buildCompletedExportCsv(epoch: { appDate: string }): Buffer {
  return Buffer.from(
    [
      "\uFEFF记录类型,用户 ID,名称,邮箱,业务时间,角色,封禁,留存",
      `new_user,${OPERATIONS_E2E_USERS.user.id},${OPERATIONS_E2E_USERS.user.name},${OPERATIONS_E2E_USERS.user.email},${epoch.appDate}T01:00:00.000+08:00,user,false,false`,
      "",
    ].join("\r\n"),
    "utf8"
  );
}

/** 构造仍保留对象但已超过业务保留期的内容导出 CSV。 */
function buildExpiredExportCsv(): Buffer {
  return Buffer.from(
    "\uFEFF任务 ID,用户 ID,模型,媒体类型,业务时间,状态,数量,视频秒数,积分净用量\r\noperations-e2e-image-task,operations-e2e-user,operations-e2e-image-model,image,2026-08-14T02:00:00.000+08:00,completed,3,0,12.34\r\n",
    "utf8"
  );
}

/**
 * 将测试对象写入专用本地存储，并返回与文件内容一致的数据库元数据。
 *
 * @failure 路径逃逸专用根目录或文件系统写入失败时显式终止测试准备。
 */
async function writeFixtureExportObject(
  environment: OperationsE2EEnvironment,
  taskId: string,
  content: Buffer
): Promise<FixtureExportObject> {
  const key = `operations-exports/${taskId}/fixture.csv`;
  const filePath = join(
    environment.localStoragePath,
    environment.storageBucketName,
    key
  );
  const relativePath = relative(environment.localStoragePath, filePath);
  if (relativePath.startsWith("..") || relativePath === "") {
    throw new Error("运营 E2E 导出对象路径逃逸专用存储目录");
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return {
    bucket: environment.storageBucketName,
    key,
    checksumSha256: createHash("sha256").update(content).digest("hex"),
    rowCount: 1,
    byteCount: content.byteLength,
  };
}

/** 强制专用数据库使用与测试进程一致的本地存储配置。 */
async function configureFixtureStorage(
  client: PoolClient,
  environment: OperationsE2EEnvironment
): Promise<void> {
  const settings = [
    ["STORAGE_ENDPOINT", ""],
    ["STORAGE_BUCKET_NAME", environment.storageBucketName],
    ["LOCAL_STORAGE_PATH", environment.localStoragePath],
  ] as const;
  for (const [key, value] of settings) {
    await client.query(
      `
        insert into system_setting (
          key, value, is_secret, created_at, updated_at
        ) values ($1, to_jsonb($2::text), false, now(), now())
        on conflict (key) do update set
          value = excluded.value,
          is_secret = false,
          updated_at = excluded.updated_at
      `,
      [key, value]
    );
  }
}

/** 验证专用数据库已经应用运营总览迁移。 */
async function requireFixtureSchema(client: PoolClient): Promise<void> {
  const result = await client.query<{
    epoch: string | null;
    exportTask: string | null;
  }>(`
    select
      to_regclass('public.operations_analytics_epoch')::text as epoch,
      to_regclass('public.operations_export_task')::text as "exportTask"
  `);
  const row = result.rows[0];
  if (!row?.epoch || !row.exportTask) {
    throw new Error(
      "OPERATIONS_E2E_DATABASE_URL 尚未应用运营总览迁移；拒绝在浏览器测试中自动迁移"
    );
  }
}

/** 清除上一次同名夹具；用户级外键级联清理账号、会话和导出记录。 */
async function removeFixtureUsers(client: PoolClient): Promise<void> {
  await client.query(`delete from "user" where id = any($1::text[])`, [
    FIXTURE_USER_IDS,
  ]);
}

/** 把运营内容依赖的两个既有分析读模型推进为可读 v1 状态。 */
async function ensureAnalyticsReadModelsReady(
  client: PoolClient
): Promise<void> {
  for (const readModel of ["output_usage", "credit_usage"] as const) {
    await client.query(
      `
        insert into analytics_read_model_state (
          read_model, version, status, details, last_reconciled_at,
          created_at, updated_at
        ) values ($1, 1, 'ready', '{}'::json, now(), now(), now())
        on conflict (read_model) do update set
          version = excluded.version,
          status = excluded.status,
          details = excluded.details,
          last_reconciled_at = excluded.last_reconciled_at,
          updated_at = excluded.updated_at
      `,
      [readModel]
    );
  }
}

/** 返回相对 epoch 的稳定测试时间。 */
function offsetEpoch(startsAt: Date, offsetMilliseconds: number): Date {
  return new Date(startsAt.getTime() + offsetMilliseconds);
}

/** 创建四种角色的真实 credential 账号。 */
async function createFixtureUsers(
  client: PoolClient,
  password: string,
  epoch: { appDate: string; startsAt: Date }
): Promise<void> {
  const passwordHash = await hashPassword(password);
  for (const fixture of Object.values(OPERATIONS_E2E_USERS)) {
    const createdAt =
      fixture.id === OPERATIONS_E2E_USERS.user.id
        ? offsetEpoch(epoch.startsAt, 60 * 60_000)
        : offsetEpoch(epoch.startsAt, -10 * 86_400_000);
    await client.query(
      `
        insert into "user" (
          id, name, email, email_verified, role, banned, created_at, updated_at
        ) values ($1, $2, $3, true, $4, false, $5, $5)
      `,
      [fixture.id, fixture.name, fixture.email, fixture.role, createdAt]
    );
    await client.query(
      `
        insert into account (
          id, account_id, provider_id, user_id, password, created_at, updated_at
        ) values ($1, $2, 'credential', $2, $3, $4, $4)
      `,
      [
        `operations-e2e-account-${fixture.role}`,
        fixture.id,
        passwordHash,
        createdAt,
      ]
    );
  }
}

/**
 * 幂等初始化测试库 epoch；已有值保持不可变并作为导出夹具口径。
 *
 * @returns 数据库权威 epoch 日期和 UTC 起点。
 */
async function ensureFixtureEpoch(
  client: PoolClient
): Promise<{ appDate: string; startsAt: Date }> {
  await client.query(
    `
      insert into operations_analytics_epoch (
        id,
        app_date,
        starts_at,
        initialized_by,
        initialization_request_id,
        created_at
      )
      select
        1,
        to_char((now() at time zone 'Asia/Shanghai')::date, 'YYYY-MM-DD'),
        ((now() at time zone 'Asia/Shanghai')::date)::timestamp,
        $1,
        'operations-e2e-epoch-v1',
        now()
      on conflict (id) do nothing
    `,
    [OPERATIONS_E2E_USERS.super_admin.id]
  );
  const result = await client.query<{ appDate: string; startsAt: Date }>(`
    select app_date as "appDate", starts_at as "startsAt"
    from operations_analytics_epoch
    where id = 1
  `);
  const epoch = result.rows[0];
  if (!epoch) throw new Error("运营 E2E epoch 初始化后仍不可读");
  return epoch;
}

/** 创建 completed、failed、expired 三种固定导出记录。 */
async function createFixtureExports(
  client: PoolClient,
  epoch: { appDate: string; startsAt: Date },
  environment: OperationsE2EEnvironment
): Promise<void> {
  const objects = new Map<string, FixtureExportObject>([
    [
      COMPLETED_EXPORT_ID,
      await writeFixtureExportObject(
        environment,
        COMPLETED_EXPORT_ID,
        buildCompletedExportCsv(epoch)
      ),
    ],
    [
      EXPIRED_EXPORT_ID,
      await writeFixtureExportObject(
        environment,
        EXPIRED_EXPORT_ID,
        buildExpiredExportCsv()
      ),
    ],
  ]);
  const fixtures = [
    {
      id: COMPLETED_EXPORT_ID,
      requestId: "operations-e2e-export-completed-v1",
      exportType: "user_growth",
      status: "completed",
      createdOffsetMinutes: -3 * 24 * 60,
      completedOffsetMinutes: -2 * 24 * 60,
      expiresOffsetDays: 5,
      errorCode: null,
    },
    {
      id: "operations-e2e-export-failed",
      requestId: "operations-e2e-export-failed-v1",
      exportType: "commercialization",
      status: "failed",
      createdOffsetMinutes: -2 * 24 * 60,
      completedOffsetMinutes: null,
      expiresOffsetDays: null,
      errorCode: "fixture_failure",
    },
    {
      id: EXPIRED_EXPORT_ID,
      requestId: "operations-e2e-export-expired-v1",
      exportType: "content_production",
      status: "expired",
      createdOffsetMinutes: -9 * 24 * 60,
      completedOffsetMinutes: -8 * 24 * 60,
      expiresOffsetDays: -1,
      errorCode: null,
    },
  ] as const;
  for (const fixture of fixtures) {
    const completedAt =
      fixture.completedOffsetMinutes === null
        ? null
        : new Date(Date.now() + fixture.completedOffsetMinutes * 60_000);
    const expiresAt =
      fixture.expiresOffsetDays === null
        ? null
        : new Date(Date.now() + fixture.expiresOffsetDays * 86_400_000);
    const object = objects.get(fixture.id) ?? null;
    await client.query(
      `
        insert into operations_export_task (
          id, created_by, client_request_id, export_type, status, query,
          time_zone, epoch_app_date, epoch_starts_at, schema_version,
          snapshot_at, high_watermarks, attempt_count,
          object_bucket, object_key, checksum_sha256, row_count, byte_count,
          error_code, completed_at, expires_at, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6::json, 'Asia/Shanghai', $7, $8, 1,
          now(), '{}'::json, 1,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17, now()
        )
      `,
      [
        fixture.id,
        OPERATIONS_E2E_USERS.admin.id,
        fixture.requestId,
        fixture.exportType,
        fixture.status,
        JSON.stringify({
          granularity: "day",
          range: { kind: "default" },
        }),
        epoch.appDate,
        epoch.startsAt,
        object?.bucket ?? null,
        object?.key ?? null,
        object?.checksumSha256 ?? null,
        object?.rowCount ?? null,
        object?.byteCount ?? null,
        fixture.errorCode,
        completedAt,
        expiresAt,
        new Date(Date.now() + fixture.createdOffsetMinutes * 60_000),
      ]
    );
  }
}

/**
 * 创建可由 overview、明细和图表共同读取的最小真实运营事实。
 *
 * WHY：浏览器测试必须验证同一事实链，而不是只对空态和模拟响应做断言。
 */
async function createFixtureOperationsFacts(
  client: PoolClient,
  epoch: { appDate: string; startsAt: Date }
): Promise<void> {
  const userId = OPERATIONS_E2E_USERS.user.id;
  const visitAt = offsetEpoch(epoch.startsAt, 90 * 60_000);
  const imageAt = offsetEpoch(epoch.startsAt, 2 * 60 * 60_000);
  const videoAt = offsetEpoch(epoch.startsAt, 3 * 60 * 60_000);
  const orderCreatedAt = offsetEpoch(epoch.startsAt, 4 * 60 * 60_000);
  const orderFulfilledAt = offsetEpoch(epoch.startsAt, 5 * 60 * 60_000);

  await client.query(
    `
      insert into user_web_visit (
        user_id, app_date, first_visited_at, created_at
      ) values ($1, $2, $3, $3)
    `,
    [userId, epoch.appDate, visitAt]
  );
  await client.query(
    `
      insert into generation (
        id, user_id, usage_log_visible, prompt, model, status,
        credits_consumed, created_at, completed_at
      ) values (
        'operations-e2e-image-task', $1, true, 'fixture prompt',
        'operations-e2e-image-model', 'completed', 12.34, $2, $3
      )
    `,
    [userId, imageAt, offsetEpoch(imageAt, 30_000)]
  );
  await client.query(
    `
      insert into video_generation (
        id, user_id, principal_scope, usage_log_visible, model,
        adobe_request_profile, adobe_auth_profile, prompt, duration_seconds,
        aspect_ratio, resolution, status, stage, credits_consumed,
        created_at, updated_at, completed_at
      ) values (
        'operations-e2e-video-task', $1, 'user:operations-e2e-user', true,
        'sora2', 'express', 'express', 'fixture prompt',
        12, '16:9', '720p', 'completed', 'completed', 4.56, $2, $3, $3
      )
    `,
    [userId, videoAt, offsetEpoch(videoAt, 60_000)]
  );
  await client.query(
    `
      insert into user_output_usage_event (
        output_kind, source_task_id, user_id, operation_created_at,
        image_count, video_seconds, created_at
      ) values
        ('image', 'operations-e2e-image-task', $1, $2, 3, 0, $2),
        ('video', 'operations-e2e-video-task', $1, $3, 0, 12, $3)
    `,
    [userId, imageAt, videoAt]
  );
  await client.query(
    `
      insert into credit_usage_operation (
        user_id, operation_type, operation_id, operation_created_at,
        gross_consumed, refunded, net_consumed, created_at, updated_at
      ) values
        ($1, 'image_generation', 'operations-e2e-image-task', $2,
          12.34, 0, 12.34, $2, $2),
        ($1, 'video_generation', 'operations-e2e-video-task', $3,
          4.56, 0, 4.56, $3, $3)
    `,
    [userId, imageAt, videoAt]
  );
  await client.query(
    `
      insert into payment_order (
        id, user_id, client_request_id, provider, purpose, status, currency,
        amount, amount_minor, credits_amount, pricing_snapshot,
        provider_trade_no, fulfilled_at, created_at, updated_at
      ) values (
        'operations-e2e-payment-order', $1, 'operations-e2e-payment-request',
        'fixture', 'credit_top_up', 'fulfilled', 'CNY', 19.900, 1990,
        200.00, '{}'::json, 'operations-e2e-provider-trade', $3, $2, $3
      )
    `,
    [userId, orderCreatedAt, orderFulfilledAt]
  );
  await client.query(
    `
      insert into payment_lifecycle_event (
        id, payment_order_id, event_type, source_ref, occurred_at,
        recorded_at, timestamp_source, provider
      ) values
        ('operations-e2e-payment-created', 'operations-e2e-payment-order',
          'order_created', 'operations-e2e-payment-created', $1, $1,
          'server_generated', 'fixture'),
        ('operations-e2e-payment-confirmed', 'operations-e2e-payment-order',
          'payment_confirmed', 'operations-e2e-payment-confirmed', $2, $2,
          'provider', 'fixture'),
        ('operations-e2e-payment-fulfilled', 'operations-e2e-payment-order',
          'fulfillment_succeeded', 'operations-e2e-payment-fulfilled', $3, $3,
          'server_generated', 'fixture')
    `,
    [orderCreatedAt, offsetEpoch(orderCreatedAt, 30 * 60_000), orderFulfilledAt]
  );
}

/** 只重建当前管理员的固定导出状态，供每个浏览器场景隔离写入。 */
export async function resetOperationsE2EExports(
  environment: OperationsE2EEnvironment
): Promise<void> {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from operations_export_task where created_by = $1`,
      [OPERATIONS_E2E_USERS.admin.id]
    );
    const epoch = await ensureFixtureEpoch(client);
    await configureFixtureStorage(client, environment);
    await createFixtureExports(client, epoch, environment);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * 重建浏览器测试夹具。
 *
 * @param environment 已验证的 E2E 环境。
 * @sideEffects 仅在专用测试库中删除并重建固定测试用户、账号与导出任务。
 */
export async function seedOperationsE2EFixture(
  environment: OperationsE2EEnvironment
): Promise<void> {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireFixtureSchema(client);
    await removeFixtureUsers(client);
    const epoch = await ensureFixtureEpoch(client);
    await createFixtureUsers(client, environment.password, epoch);
    await ensureAnalyticsReadModelsReady(client);
    await createFixtureOperationsFacts(client, epoch);
    await configureFixtureStorage(client, environment);
    await createFixtureExports(client, epoch, environment);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * 删除固定夹具用户及其级联记录；不可变 epoch 按生产语义保留。
 *
 * @param environment 已验证的 E2E 环境。
 * @sideEffects 只删除专用测试库中的固定用户 ID。
 */
export async function cleanupOperationsE2EFixture(
  environment: OperationsE2EEnvironment
): Promise<void> {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  try {
    await pool.query(`delete from "user" where id = any($1::text[])`, [
      FIXTURE_USER_IDS,
    ]);
  } finally {
    await pool.end();
  }
}

/**
 * 删除运营 E2E 专用本地存储目录。
 *
 * WHY：目录由环境模块固定在 test-results 下，测试前后清理可避免复用开发存储，
 * 同时防止旧对象让下载场景产生假阳性。
 */
export async function cleanupOperationsE2EStorage(
  environment: OperationsE2EEnvironment
): Promise<void> {
  const normalized = environment.localStoragePath.replaceAll("\\", "/");
  if (!normalized.endsWith("/test-results/operations-dashboard/storage")) {
    throw new Error("拒绝删除非运营 E2E 专用存储目录");
  }
  await rm(environment.localStoragePath, { force: true, recursive: true });
}

/** 查询指定导出任务的下载许可与实际流式读取审计。 */
export async function readOperationsE2EDownloadAuditResults(
  environment: OperationsE2EEnvironment,
  taskId: string
): Promise<string[]> {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ result: string }>(
      `
        select metadata->>'result' as result
        from admin_audit_log
        where action = 'operations.downloadExport'
          and admin_user_id = $1
          and after->>'taskId' = $2
        order by created_at, id
      `,
      [OPERATIONS_E2E_USERS.admin.id, taskId]
    );
    return result.rows.map((row) => row.result);
  } finally {
    await pool.end();
  }
}

/** 将当前管理员最新排队任务推进为带真实对象的完成状态。 */
export async function completeLatestOperationsE2EExport(
  environment: OperationsE2EEnvironment
): Promise<string> {
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const taskResult = await client.query<{ id: string }>(
      `
        select id
        from operations_export_task
        where created_by = $1 and status = 'queued'
        order by created_at desc, id desc
        limit 1
      `,
      [OPERATIONS_E2E_USERS.admin.id]
    );
    const task = taskResult.rows[0];
    if (!task) throw new Error("没有可完成的运营 E2E 排队任务");
    const epoch = await ensureFixtureEpoch(client);
    const object = await writeFixtureExportObject(
      environment,
      task.id,
      buildCompletedExportCsv(epoch)
    );
    const completedAt = new Date();
    const update = await client.query<{ id: string }>(
      `
        update operations_export_task
        set status = 'completed',
            object_bucket = $2,
            object_key = $3,
            checksum_sha256 = $4,
            row_count = $5,
            byte_count = $6,
            completed_at = $7,
            expires_at = $8,
            updated_at = $7
        where id = $1 and status = 'queued'
        returning id
      `,
      [
        task.id,
        object.bucket,
        object.key,
        object.checksumSha256,
        object.rowCount,
        object.byteCount,
        completedAt,
        new Date(completedAt.getTime() + 7 * 86_400_000),
      ]
    );
    if (!update.rows[0]) throw new Error("运营 E2E 排队任务完成状态竞争失败");
    return task.id;
  } finally {
    client.release();
    await pool.end();
  }
}

/** 插入稳定的失败历史记录，使浏览器覆盖 HMAC cursor 翻页路径。 */
export async function seedOperationsE2EExportHistory(
  environment: OperationsE2EEnvironment,
  count: number
): Promise<void> {
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new RangeError("运营 E2E 导出历史数量必须为 1 到 100 的整数");
  }
  const pool = new Pool({ connectionString: environment.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const epoch = await ensureFixtureEpoch(client);
    for (let index = 0; index < count; index += 1) {
      const createdAt = new Date(Date.now() - (10 + index) * 60_000);
      await client.query(
        `
          insert into operations_export_task (
            id, created_by, client_request_id, export_type, status, query,
            time_zone, epoch_app_date, epoch_starts_at, schema_version,
            snapshot_at, high_watermarks, attempt_count, error_code,
            created_at, updated_at
          ) values (
            $1, $2, $3, 'user_growth', 'failed', $4::json,
            'Asia/Shanghai', $5, $6, 1,
            $7, '{}'::json, 1, 'fixture_history', $7, $7
          )
        `,
        [
          `operations-e2e-export-history-${index + 1}`,
          OPERATIONS_E2E_USERS.admin.id,
          `operations-e2e-export-history-request-${index + 1}`,
          JSON.stringify({
            granularity: "day",
            range: { kind: "default" },
          }),
          epoch.appDate,
          epoch.startsAt,
          createdAt,
        ]
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}
