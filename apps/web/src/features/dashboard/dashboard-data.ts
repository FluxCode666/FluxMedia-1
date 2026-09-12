/**
 * 用户控制台首页的统一服务端数据装配器。
 *
 * 首屏 Server Component 与刷新 Server Action 共用本模块，确保近 24 小时摘要、模型
 * 分布和近期创作采用同一用户 Principal。
 */
import type { UsageSummaryOutput } from "@repo/shared/analytics/contracts";
import type { AppUserRole } from "@repo/shared/auth/roles";
import type { WalletBalanceSnapshot } from "@repo/shared/credits/wallet-contract";
import { logError } from "@repo/shared/logger";
import { requestGoJson } from "@/server/go-backend-client";

import type { RecentCreation } from "@/features/image-generation/components/recent-creations-client";

export type DashboardSnapshot = {
  summary: UsageSummaryOutput;
  creditBalance: WalletBalanceSnapshot;
  recentCreations: RecentCreation[];
};

type DashboardSnapshotDependencies = {
  ensureInitialized: () => Promise<void>;
  loadSummary: (input: {
    userId: string;
    role: AppUserRole;
  }) => Promise<UsageSummaryOutput>;
  loadBalance: (input: {
    userId: string;
    role: AppUserRole;
  }) => Promise<WalletBalanceSnapshot>;
  loadRecentCreations: (userId: string) => Promise<RecentCreation[]>;
  reportRecentCreationsError: (error: Error) => void;
};

/**
 * 读取当前用户最近四项已完成图片创作。
 *
 * @param userId 当前会话 Principal 的用户 ID。
 * @returns 可直接交给 RecentCreationsClient 的签名 URL 数据；无记录时返回空数组。
 */
export async function loadRecentDashboardCreations(
  _userId: string
): Promise<RecentCreation[]> {
  // The Go endpoint derives ownership from the forwarded session cookie. Keep
  // userId in the function signature for the existing dependency contract, but
  // never trust a caller-provided ID when selecting records.
  return requestGoJson<RecentCreation[]>("/api/image-generation/recent?limit=4");
}

/** 通过 Analytics UOL 读取本人摘要，身份只来自服务端 Principal。 */
async function loadSummaryThroughUol(input: {
  userId: string;
  role: AppUserRole;
}): Promise<UsageSummaryOutput> {
  void input;
  return requestGoJson<UsageSummaryOutput>("/api/analytics/summary");
}

/** 通过 Credits UOL 读取本人当前余额，身份只来自服务端 Principal。 */
async function loadBalanceThroughUol(input: {
  userId: string;
  role: AppUserRole;
}): Promise<WalletBalanceSnapshot> {
  void input;
  return requestGoJson<WalletBalanceSnapshot>("/api/credits/balance");
}

/**
 * 从 Drizzle 包装错误中提取安全的数据库根因字段。
 *
 * 外层错误包含完整 SQL 和绑定参数，不能直接进入日志；若根因缺失则只记录通用消息。
 */
function sanitizeRecentCreationsError(error: unknown): Error {
  return new Error(
    error instanceof Error ? error.message : "Recent creations query failed"
  );
}

/** 记录脱敏后的近期创作降级原因，但不让非关键画廊预览拖垮控制台主体。 */
function reportRecentCreationsError(error: Error): void {
  logError(new Error("Dashboard recent creations are unavailable"), {
    source: "dashboard-recent-creations",
    databaseError: error,
  });
}

const defaultSnapshotDependencies: DashboardSnapshotDependencies = {
  // All three reads below are Go first-party endpoints. Keep the dependency
  // hook for tests and older callers, but do not initialize the Next UOL.
  ensureInitialized: async () => undefined,
  loadSummary: loadSummaryThroughUol,
  loadBalance: loadBalanceThroughUol,
  loadRecentCreations: loadRecentDashboardCreations,
  reportRecentCreationsError,
};

/**
 * 装配控制台首屏或刷新快照。
 *
 * @param input 当前用户与角色；身份只用于构造本人 Principal。
 * @returns 摘要、余额和近期创作；近期创作失败时降级为空，核心统计失败时整体拒绝。
 */
export async function loadDashboardSnapshot(
  input: {
    userId: string;
    role: AppUserRole;
  },
  dependencies: DashboardSnapshotDependencies = defaultSnapshotDependencies
): Promise<DashboardSnapshot> {
  await dependencies.ensureInitialized();
  const recentCreationsPromise = dependencies
    .loadRecentCreations(input.userId)
    .catch((error: unknown) => {
      dependencies.reportRecentCreationsError(
        sanitizeRecentCreationsError(error)
      );
      return [];
    });
  const [summary, creditBalance, recentCreations] = await Promise.all([
    dependencies.loadSummary({ userId: input.userId, role: input.role }),
    dependencies.loadBalance({ userId: input.userId, role: input.role }),
    recentCreationsPromise,
  ]);
  return { summary, creditBalance, recentCreations };
}
