/**
 * Dashboard 网页访问事实的站内调用适配器。
 *
 * 使用方：dashboard 公共布局和跨自然日 Server Action。身份只由真实 session 构造，
 * 统计失败记录不含用户、会话、路径或浏览器信息的告警，并返回 null 让页面继续渲染。
 */
import { logWarn } from "@repo/shared/logger";
import type { RecordWebVisitOutput } from "@repo/shared/operations-dashboard/facts-contracts";
import { requestGoJson } from "@/server/go-backend-client";

/**
 * 为已验证 dashboard session 记录当日网页访问。
 *
 * @param userId 服务端 session 中的用户 ID。
 * @param role 服务端数据库读取的当前角色。
 * @returns 成功时返回自然日和是否首次写入；失败时返回 null。
 * @sideEffects 通过 UOL 最多写入一行访问事实；失败时写一条脱敏警告。
 */
export async function tryRecordDashboardWebVisit(
  userId: string,
  _role?: unknown
): Promise<RecordWebVisitOutput | null> {
  try {
    // The Go endpoint derives identity from the forwarded session cookie. Keep
    // the userId parameter for the existing layout contract, but never send it
    // over the wire where it could be confused with caller-provided identity.
    void userId;
    return await requestGoJson<RecordWebVisitOutput>(
      "/api/operations/web-visit",
      { method: "POST", body: "{}" }
    );
  } catch (error) {
    logWarn("Dashboard web visit recording failed", {
      source: "dashboard-web-visit",
      operation: "operations.recordWebVisit",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}
