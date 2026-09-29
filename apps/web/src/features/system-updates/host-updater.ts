/**
 * 与宿主机站内系统更新器（deploy/system-update-runner.sh）的文件协议。
 *
 * 使用方：/api/admin/system-updates。
 * 协议：宿主机把两个目录挂载进 app 容器（见 deploy/docker-compose.yml）：
 *   - status/status.json：root 写入、app 只读的更新状态；
 *   - requests/update-request.json：app 唯一可写的更新请求，systemd path 单元据此触发 runner。
 * 请求只携带版本号与请求元数据；runner 会再次校验版本（仅稳定版且必须高于当前版本），
 * 并从公开 GitHub Release 下载校验部署包，因此 app 无法借请求执行任意发布。
 * 失败模式：目录未挂载时视为更新器未安装；状态文件损坏时按“无状态”处理而不是报错，
 * 避免页面因宿主机状态异常而完全不可用。
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const DEFAULT_SYSTEM_UPDATE_DIR = "/app/system-update";
const REQUEST_FILE_NAME = "update-request.json";
// systemd service 的 TimeoutStartSec 为 2 小时；超过该时长仍为 running 说明 runner 已被强杀。
const RUNNING_STALE_AFTER_MS = 150 * 60 * 1000;
// path 单元通常在秒级取走请求；长时间未被取走说明宿主机更新器未运行。
const PENDING_STALE_AFTER_MS = 10 * 60 * 1000;
const REQUESTED_BY_PATTERN = /[^A-Za-z0-9_-]/g;

const statusSchema = z.object({
  state: z.enum(["idle", "running", "succeeded", "failed"]),
  phase: z.string().max(64).nullable().optional(),
  error: z.string().max(64).nullable().optional(),
  targetVersion: z.string().max(64).nullable().optional(),
  previousVersion: z.string().max(64).nullable().optional(),
  requestId: z.string().max(128).nullable().optional(),
  startedAt: z.string().max(64).nullable().optional(),
  finishedAt: z.string().max(64).nullable().optional(),
  updatedAt: z.string().max(64).nullable().optional(),
  logTail: z.array(z.string().max(1000)).max(200).optional(),
});

const pendingRequestSchema = z.object({
  version: z.string().max(64),
  requestId: z.string().max(128),
});

export type SystemUpdateStatus = {
  state: "idle" | "running" | "succeeded" | "failed";
  phase: string | null;
  error: string | null;
  targetVersion: string | null;
  previousVersion: string | null;
  requestId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  logTail: string[];
  /** running 状态长时间未更新：runner 大概率已被中断，允许重新发起。 */
  stale: boolean;
};

export type PendingUpdateRequest = {
  version: string;
  requestId: string;
  requestedAt: string;
  /** 请求长时间未被宿主机取走：更新器可能未运行。 */
  stale: boolean;
};

export type HostUpdaterState = {
  /** requests 目录已挂载且可写，即宿主机更新器已安装。 */
  available: boolean;
  status: SystemUpdateStatus | null;
  pendingRequest: PendingUpdateRequest | null;
};

function systemUpdateDirectory() {
  return (
    process.env.FLUXMEDIA_SYSTEM_UPDATE_DIR?.trim() || DEFAULT_SYSTEM_UPDATE_DIR
  );
}

function requestsDirectory() {
  return path.join(systemUpdateDirectory(), "requests");
}

export async function readHostUpdaterState(
  now = Date.now()
): Promise<HostUpdaterState> {
  const [available, status, pendingRequest] = await Promise.all([
    isRequestsDirectoryWritable(),
    readStatus(now),
    readPendingRequest(now),
  ]);
  return { available, status, pendingRequest };
}

/** 更新是否正在进行（含已排队但未被取走的请求）；陈旧状态不阻塞新的请求。 */
export function isUpdateInProgress(state: HostUpdaterState) {
  if (state.pendingRequest && !state.pendingRequest.stale) return true;
  return state.status?.state === "running" && !state.status.stale;
}

/**
 * 原子写入更新请求：先写同目录临时文件再 rename，path 单元只会看到完整的请求文件。
 */
export async function requestHostUpdate(input: {
  version: string;
  requestedBy: string;
}) {
  const requestId = randomUUID();
  const directory = requestsDirectory();
  const temporaryPath = path.join(directory, `.${requestId}.tmp`);
  const payload = JSON.stringify({
    version: input.version,
    requestId,
    requestedBy: input.requestedBy
      .replace(REQUESTED_BY_PATTERN, "")
      .slice(0, 128),
  });
  try {
    await writeFile(temporaryPath, payload, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path.join(directory, REQUEST_FILE_NAME));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { requestId };
}

async function isRequestsDirectoryWritable() {
  try {
    const directory = requestsDirectory();
    if (!(await stat(directory)).isDirectory()) return false;
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function readStatus(now: number): Promise<SystemUpdateStatus | null> {
  const document = await readJsonFile(
    path.join(systemUpdateDirectory(), "status", "status.json")
  );
  const parsed = statusSchema.safeParse(document);
  if (!parsed.success) return null;
  const status = parsed.data;
  const updatedAt = status.updatedAt
    ? Date.parse(status.updatedAt)
    : Number.NaN;
  return {
    state: status.state,
    phase: status.phase ?? null,
    error: status.error ?? null,
    targetVersion: status.targetVersion ?? null,
    previousVersion: status.previousVersion ?? null,
    requestId: status.requestId ?? null,
    startedAt: status.startedAt ?? null,
    finishedAt: status.finishedAt ?? null,
    updatedAt: status.updatedAt ?? null,
    logTail: status.logTail ?? [],
    stale:
      status.state === "running" &&
      (!Number.isFinite(updatedAt) || now - updatedAt > RUNNING_STALE_AFTER_MS),
  };
}

async function readPendingRequest(
  now: number
): Promise<PendingUpdateRequest | null> {
  const requestPath = path.join(requestsDirectory(), REQUEST_FILE_NAME);
  let modifiedAt: number;
  try {
    modifiedAt = (await stat(requestPath)).mtimeMs;
  } catch {
    return null;
  }
  const parsed = pendingRequestSchema.safeParse(
    await readJsonFile(requestPath)
  );
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    requestedAt: new Date(modifiedAt).toISOString(),
    stale: now - modifiedAt > PENDING_STALE_AFTER_MS,
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
