/**
 * 站内系统更新的接口类型与纯状态推导。
 *
 * 使用方：system-version-control.tsx。Go 端 GET/POST /api/admin/system-update 负责
 * 下载、校验、解压、备份并请求容器重启；重启后 boot.mjs 在业务端口上返回
 * 503 SYSTEM_UPDATING 并执行迁移。这里把三类响应（Go 状态、维护响应、连接失败）
 * 归一成界面步骤，便于脱离 React 测试。
 */

export type SystemUpdateJobState = "idle" | "running" | "restarting" | "failed";

export type SystemUpdateJob = {
  state: SystemUpdateJobState;
  phase?: string;
  targetVersion?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type SystemUpdateResult = {
  status: "succeeded" | "failed";
  code: string;
  message: string | null;
  version: string | null;
  fromVersion: string | null;
  warnings?: string[];
  finishedAt: string;
};

export type SystemUpdateStatus = {
  currentVersion: string;
  imageVersion: string;
  updater: { available: boolean; reason?: string };
  latestRelease: {
    version: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string;
    installable: boolean;
    blockedReason?: string;
  } | null;
  releaseError?: string;
  updateAvailable: boolean;
  job: SystemUpdateJob;
  lastResult: SystemUpdateResult | null;
};

/** 一次轮询的归一结果：正常状态、重启后的迁移维护响应，或服务暂不可达。 */
export type SystemUpdateProbe =
  | { kind: "status"; status: SystemUpdateStatus }
  | { kind: "maintenance"; phase: string; targetVersion: string | null }
  | { kind: "unreachable" }
  | { kind: "error"; status: number; code: string | null };

export const SYSTEM_UPDATE_STEPS = [
  "downloading",
  "verifying",
  "extracting",
  "backing_up",
  "restarting",
  "migrating",
  "done",
] as const;

export type SystemUpdateStep = (typeof SYSTEM_UPDATE_STEPS)[number];

/** 有专门文案的错误码；其余统一显示 unknown，避免把内部信息原样展示。 */
export const SYSTEM_UPDATE_ERROR_CODES = [
  "download_failed",
  "checksum_mismatch",
  "extract_failed",
  "bundle_invalid",
  "platform_changed",
  "releases_dir_unavailable",
  "backup_failed",
  "state_write_failed",
  "restart_failed",
  "update_failed",
  "migration_failed",
  "release_invalid",
  "too_many_attempts",
  "release_changed",
  "already_current",
  "update_in_progress",
] as const;

export const SYSTEM_UPDATE_BLOCKED_REASONS = [
  "dev_build",
  "unsupported_platform",
  "unsupported_runtime",
  "backup_unavailable",
  "releases_dir_unavailable",
  "platform_changed",
  "unsupported_release",
  "bundle_missing",
  "bundle_too_large",
] as const;

export const SYSTEM_UPDATE_RELEASE_ERRORS = [
  "release_not_found",
  "github_rate_limited",
  "github_unavailable",
  "github_response_too_large",
] as const;

/** 服务重启与迁移期间网关可能返回的暂态状态码。 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** 把已知码映射为消息键；未知码回退到 fallback，防止缺失翻译抛错。 */
export function knownCode<T extends string>(
  code: string | null | undefined,
  known: readonly T[],
  fallback: T | "unknown" = "unknown"
): T | "unknown" {
  const normalized = code?.toLowerCase();
  return (known as readonly string[]).includes(normalized ?? "")
    ? (normalized as T)
    : fallback;
}

/**
 * 解析一次 GET 响应。
 *
 * @param response fetch 结果；null 表示网络失败（容器重启中）。
 * @returns 归一后的探测结果；维护响应带出迁移阶段。
 */
export async function readSystemUpdateProbe(
  response: Response | null
): Promise<SystemUpdateProbe> {
  if (!response) return { kind: "unreachable" };
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string } | string;
    update?: { phase?: string; targetVersion?: string };
  } | null;
  if (response.ok && body) {
    return { kind: "status", status: body as unknown as SystemUpdateStatus };
  }
  const code =
    typeof body?.error === "object" ? (body.error.code ?? null) : null;
  if (response.status === 503 && code === "SYSTEM_UPDATING") {
    return {
      kind: "maintenance",
      phase: body?.update?.phase ?? "migrating",
      targetVersion: body?.update?.targetVersion ?? null,
    };
  }
  // Go 刚退出、supervisor 尚未拉起新进程时，网关或 Node 会短暂返回 5xx。
  if (TRANSIENT_STATUSES.has(response.status) || !body) {
    return { kind: "unreachable" };
  }
  return { kind: "error", status: response.status, code };
}

/** 当前更新所处步骤；未在更新中返回 null。 */
export function currentStep(probe: SystemUpdateProbe): SystemUpdateStep | null {
  if (probe.kind === "unreachable") return "restarting";
  if (probe.kind === "maintenance") return "migrating";
  if (probe.kind !== "status") return null;
  const { job } = probe.status;
  if (job.state === "restarting") return "restarting";
  if (job.state !== "running") return null;
  return (SYSTEM_UPDATE_STEPS as readonly string[]).includes(job.phase ?? "")
    ? (job.phase as SystemUpdateStep)
    : "downloading";
}

export type TrackedUpdate = {
  version: string;
  /** 服务端返回的任务开始时间，用来排除 state.json 中更早的同版本结果。 */
  startedAt: string | null;
};

export type TrackedOutcome =
  | { kind: "pending"; step: SystemUpdateStep }
  | { kind: "succeeded"; warnings: string[] }
  | { kind: "failed"; code: string }
  | { kind: "unknown" };

function isAfter(value: string | null | undefined, reference: string | null) {
  if (!value) return false;
  if (!reference) return true;
  return Date.parse(value) >= Date.parse(reference);
}

/**
 * 根据最新探测结果判断本页发起（或接手）的更新是否结束。
 *
 * WHY：Go 进程重启后内存中的任务会丢失，最终结果只能从 currentVersion 与
 * boot.mjs 写入的 lastResult 推断；lastResult 必须晚于任务开始才算本次结果。
 */
export function trackedOutcome(
  tracked: TrackedUpdate,
  probe: SystemUpdateProbe
): TrackedOutcome {
  if (probe.kind === "error")
    return { kind: "failed", code: probe.code ?? "update_failed" };
  if (probe.kind !== "status") {
    return { kind: "pending", step: currentStep(probe) ?? "restarting" };
  }
  const { status } = probe;
  const result = status.lastResult;
  const resultIsCurrent =
    result?.version === tracked.version &&
    isAfter(result.finishedAt, tracked.startedAt);
  if (status.currentVersion === tracked.version) {
    return {
      kind: "succeeded",
      warnings:
        resultIsCurrent && result?.status === "succeeded"
          ? (result.warnings ?? [])
          : [],
    };
  }
  if (
    status.job.state === "failed" &&
    status.job.targetVersion === tracked.version
  ) {
    return { kind: "failed", code: status.job.error ?? "update_failed" };
  }
  if (resultIsCurrent && result?.status === "failed") {
    return { kind: "failed", code: result.code };
  }
  const step = currentStep(probe);
  if (step) return { kind: "pending", step };
  return { kind: "unknown" };
}

/** 下载进度百分比；总大小未知时返回 null。 */
export function downloadPercent(job: SystemUpdateJob): number | null {
  if (!job.totalBytes || job.totalBytes <= 0) return null;
  const ratio = (job.downloadedBytes ?? 0) / job.totalBytes;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
