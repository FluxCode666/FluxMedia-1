/**
 * 本地存储运营导出的受控流式下载路由。
 *
 * 使用方：prepareExportDownload 返回的 stream URL。路由重新读取 session、角色、任务
 * 归属和七天边界；S3 模式不经此路由，直接使用 prepare operation 的短期签名 URL。
 */
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { isAdminRole } from "@repo/shared/auth/roles";
import { logError } from "@repo/shared/logger";
import type { NextRequest } from "next/server";

import {
  getOperationsExportDownloadTarget,
  OperationsExportServiceError,
} from "@/features/operations-dashboard/export-service";
import { getOperationsExportStorage } from "@/features/operations-dashboard/export-storage";
import { databaseOperationsExportTaskRepository } from "@/features/operations-dashboard/export-task-repository";

/** 将 AsyncIterable 转换为 Web ReadableStream，并在客户端断开时取消底层读取。 */
function toReadableStream(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        await iterator.return?.();
        controller.close();
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** 只允许当前 admin/super_admin 下载自己的未过期 completed 文件。 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const role = await getUserRoleById(session.user.id);
  if (!isAdminRole(role))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const { taskId } = await context.params;
  let taskIdForAudit: string | null = null;
  try {
    const task = await getOperationsExportDownloadTarget({
      taskId,
      createdBy: session.user.id,
    });
    taskIdForAudit = task.id;
    const storage = await getOperationsExportStorage();
    if (storage.remote)
      return Response.json(
        { error: "Use signed download URL" },
        { status: 409 }
      );
    const source = await storage.getObjectStream(
      task.objectKey,
      task.objectBucket,
      { signal: request.signal }
    );
    await databaseOperationsExportTaskRepository.recordDownload({
      taskId: task.id,
      createdBy: session.user.id,
      mode: "stream",
      result: "started",
      now: new Date(),
    });
    return new Response(toReadableStream(source, request.signal), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="operations-${task.exportType}-${task.id}.csv"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (taskIdForAudit) {
      try {
        await databaseOperationsExportTaskRepository.recordDownload({
          taskId: taskIdForAudit,
          createdBy: session.user.id,
          mode: "stream",
          result: "storage_unavailable",
          now: new Date(),
        });
      } catch (auditError) {
        logError(auditError, {
          source: "operations-export-download-audit",
          taskId: taskIdForAudit,
          result: "storage_unavailable",
        });
      }
    }
    if (
      error instanceof OperationsExportServiceError &&
      error.code === "not_found"
    )
      return Response.json({ error: "Not found" }, { status: 404 });
    logError(error, {
      source: "operations-export-local-download",
      taskId: taskIdForAudit ?? taskId,
    });
    return Response.json({ error: "Export unavailable" }, { status: 503 });
  }
}
