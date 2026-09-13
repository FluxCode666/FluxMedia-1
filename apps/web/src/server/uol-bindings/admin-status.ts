/**
 * 管理状态历史错误 UOL 数据库 binding。
 *
 * 使用方：UOL 启动聚合器。精确计数、页码收敛和结果行在 repeatable-read 只读事务
 * 完成，并使用 createdAt/id 稳定排序，防止同时间写入造成页内顺序漂移。
 */
import type {
  AdminStatusErrorListOutput,
} from "@repo/shared/image-generation/admin-status-errors-contract";
import { bindOperationExecute } from "@repo/shared/uol";
import { listAdminStatusErrors } from "@repo/shared/uol/operations";
import { requestGoJson } from "@/server/go-backend-client";

/** 管理状态错误查询统一委托 Go 读模型，避免 Web 进程绕过后端直接读 generation。 */
bindOperationExecute(listAdminStatusErrors, async (input) => {
  const raw = await requestGoJson<{
    records: Array<{
      id: string;
      userId: string;
      userEmail: string | null;
      userName: string | null;
      prompt: string;
      model: string;
      size: string;
      creditsConsumed: number;
      error: string | null;
      createdAt: string;
      completedAt: string | null;
      category: "platform" | "moderation" | "user_request";
    }>;
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  }>("/api/admin/status/errors", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      fromDate: input.fromDate?.toISOString() ?? null,
      toDate: input.toDate?.toISOString() ?? null,
    }),
  });
  return {
    ...raw,
    records: raw.records.map((record) => ({
      ...record,
      createdAt: new Date(String(record.createdAt)),
      completedAt: record.completedAt
        ? new Date(String(record.completedAt))
        : null,
    })),
  } satisfies AdminStatusErrorListOutput;
});
