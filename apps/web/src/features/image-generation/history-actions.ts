"use server";

/**
 * 统一生成历史 Server Action 薄传输适配器。
 *
 * 使用方：历史记录页面、客户端分页与视频详情弹层。这里只校验机器输入、构造当前
 * 会话 Principal 并调用 UOL；查询归属、短期签名和数据库读取留在统一接口层绑定中。
 */

import {
  type AdminHistoryListOutput,
  type AdminHistoryRequestSnapshotOutput,
  adminHistoryListInputSchema,
  adminHistoryRequestSnapshotInputSchema,
  type HistoryListOutput,
  historyListInputSchema,
} from "@repo/shared/image-generation/history-contract";
import {
  globalUsageRecordsViewerAction,
  protectedAction,
} from "@repo/shared/safe-action";
import {
  videoGetInputsInputSchema,
  type videoGetInputsOutputSchema,
} from "@repo/shared/uol/operations/video-generation";
import type { z } from "zod";

import { requestGoJson } from "@/server/go-backend-client";

/** 读取当前登录用户的一页图片/视频统一历史。 */
export const getMyHistoryRecordsAction = protectedAction
  .metadata({ action: "image.listMyHistoryRecords" })
  .schema(historyListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<HistoryListOutput> => {
    void ctx;
    return requestGoJson<HistoryListOutput>("/api/image-generation/history", { method: "POST", body: JSON.stringify(parsedInput) });
  });

/** 读取管理员可见的一页全局图片/视频统一历史。 */
export const getAdminHistoryRecordsAction = globalUsageRecordsViewerAction
  .metadata({ action: "image.listAdminHistoryRecords" })
  .schema(adminHistoryListInputSchema)
  .action(async ({ parsedInput, ctx }): Promise<AdminHistoryListOutput> => {
    void ctx;
    return requestGoJson<AdminHistoryListOutput>("/api/admin/image-generation/history", { method: "POST", body: JSON.stringify(parsedInput) });
  });

/** 管理员展开详情时按需读取请求脚本处理后的脱敏真实请求正文。 */
export const getAdminHistoryRequestSnapshotAction =
  globalUsageRecordsViewerAction
    .metadata({ action: "image.getAdminHistoryRequestSnapshot" })
    .schema(adminHistoryRequestSnapshotInputSchema)
    .action(
      async ({ parsedInput, ctx }): Promise<AdminHistoryRequestSnapshotOutput> => {
        void ctx;
        return requestGoJson<AdminHistoryRequestSnapshotOutput>(
          "/api/admin/image-generation/request-snapshot",
          { method: "POST", body: JSON.stringify(parsedInput) }
        );
      }
    );

/** 按需读取视频任务具名输入；普通用户与三档历史管理员沿用 UOL 既有权限边界。 */
export const getVideoInputsAction = protectedAction
  .metadata({ action: "video.getInputs" })
  .schema(videoGetInputsInputSchema)
  .action(
    async ({
      parsedInput,
      ctx,
    }): Promise<z.output<typeof videoGetInputsOutputSchema>> => {
      void ctx;
      return requestGoJson<z.output<typeof videoGetInputsOutputSchema>>(
        "/api/image-generation/video-inputs",
        { method: "POST", body: JSON.stringify(parsedInput) }
      );
    }
  );
