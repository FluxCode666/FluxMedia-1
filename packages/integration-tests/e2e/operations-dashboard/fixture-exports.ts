/**
 * 运营总览浏览器测试的导出夹具。
 *
 * 使用方：PostgreSQL 主夹具与导出浏览器场景。模块负责固定导出任务、真实本地
 * CSV 对象和专用存储清理；事务边界仍由调用方统一控制。
 */

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { PoolClient } from "pg";

import {
  OPERATIONS_E2E_USERS,
  type OperationsE2EEnvironment,
} from "./environment";

const COMPLETED_EXPORT_ID = "operations-e2e-export-completed";
const EXPIRED_EXPORT_ID = "operations-e2e-export-expired";

export type FixtureExportObject = {
  bucket: string;
  key: string;
  checksumSha256: string;
  rowCount: number;
  byteCount: number;
};

type FixtureEpoch = {
  appDate: string;
  startsAt: Date;
};

/**
 * 构造带 UTF-8 BOM、稳定表头和一条真实用户事实的增长导出 CSV。
 *
 * @param epoch 固定运营起始自然日。
 * @returns 可直接写入本地对象存储的 UTF-8 CSV。
 */
function buildCompletedExportCsv(epoch: FixtureEpoch): Buffer {
  const header = [
    "\uFEFF记录类型",
    "用户 ID",
    "名称",
    "邮箱",
    "业务时间",
    "角色",
    "封禁",
    "留存",
  ].join(",");
  const row = [
    "new_user",
    OPERATIONS_E2E_USERS.user.id,
    OPERATIONS_E2E_USERS.user.name,
    OPERATIONS_E2E_USERS.user.email,
    `${epoch.appDate}T01:00:00.000+08:00`,
    "user",
    "false",
    "false",
  ].join(",");
  return Buffer.from([header, row, ""].join("\r\n"), "utf8");
}

/**
 * 构造仍保留对象但已超过业务保留期的内容导出 CSV。
 *
 * @returns 可直接写入本地对象存储的 UTF-8 CSV。
 */
function buildExpiredExportCsv(): Buffer {
  const header = [
    "\uFEFF任务 ID",
    "用户 ID",
    "模型",
    "媒体类型",
    "业务时间",
    "状态",
    "数量",
    "视频秒数",
    "积分净用量",
  ].join(",");
  const row = [
    "operations-e2e-image-task",
    "operations-e2e-user",
    "operations-e2e-image-model",
    "image",
    "2026-08-14T02:00:00.000+08:00",
    "completed",
    "3",
    "0",
    "12.34",
  ].join(",");
  return Buffer.from([header, row, ""].join("\r\n"), "utf8");
}

/**
 * 将测试对象写入专用本地存储，并返回与内容一致的数据库元数据。
 *
 * @param environment 已验证的专用 E2E 环境。
 * @param taskId 对象所属导出任务 ID。
 * @param content 待写入的完整 CSV 内容。
 * @returns 对象定位、校验和与精确大小。
 * @sideEffects 在专用本地存储目录创建文件。
 * @throws 路径逃逸或文件系统写入失败时终止夹具准备。
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

/**
 * 为排队任务创建与 completed 夹具同口径的真实 CSV 对象。
 *
 * @param environment 已验证的专用 E2E 环境。
 * @param taskId 排队导出任务 ID。
 * @param epoch 固定运营起始自然日与 UTC 边界。
 * @returns 对象定位、校验和与精确大小。
 * @sideEffects 在专用本地存储目录创建文件。
 * @throws 路径或文件写入失败时向调用场景传播。
 */
export function createCompletedFixtureExportObject(
  environment: OperationsE2EEnvironment,
  taskId: string,
  epoch: FixtureEpoch
): Promise<FixtureExportObject> {
  return writeFixtureExportObject(
    environment,
    taskId,
    buildCompletedExportCsv(epoch)
  );
}

/**
 * 强制专用数据库使用与测试进程一致的本地存储配置。
 *
 * @param client 由调用方管理事务的专用数据库连接。
 * @param environment 已验证的专用 E2E 环境。
 * @returns 配置写入完成后返回。
 * @sideEffects 更新专用测试库的三个存储设置。
 * @throws 数据库写入失败时向调用方传播，由调用方回滚事务。
 */
export async function configureFixtureStorage(
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

/**
 * 创建 completed、failed、expired 三种固定导出记录及其真实对象。
 *
 * @param client 由调用方管理事务的专用数据库连接。
 * @param epoch 固定运营起始自然日与 UTC 边界。
 * @param environment 已验证的专用 E2E 环境。
 * @returns 全部任务和对象创建完成后返回。
 * @sideEffects 写入本地 CSV 对象并插入专用测试库导出任务。
 * @throws 文件或数据库写入失败时传播，由调用方回滚事务并清理存储。
 */
export async function createFixtureExports(
  client: PoolClient,
  epoch: FixtureEpoch,
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
 * 删除运营 E2E 专用本地存储目录。
 *
 * WHY：目录固定在 test-results 下，前后清理可避免复用开发存储，也防止旧对象让
 * 下载场景产生假阳性。
 *
 * @param environment 已验证的专用 E2E 环境。
 * @returns 目录不存在或删除完成后返回。
 * @sideEffects 递归删除固定的 E2E 存储目录。
 * @throws 路径不属于固定测试目录时拒绝删除。
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
