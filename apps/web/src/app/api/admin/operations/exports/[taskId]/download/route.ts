/**
 * 本地存储运营导出的受控流式下载路由。
 *
 * 使用方：prepareExportDownload 返回的 stream URL。路由只构造 Principal、调用 UOL
 * 并把进程内异步字节流编码为 HTTP；归属、保留期、存储和审计均在 operation 内完成。
 */
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { logError } from "@repo/shared/logger";
import type { OperationsOpenLocalExportDownloadOutput } from "@repo/shared/operations-dashboard/output-contracts";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";

import { ensureUolInitialized } from "@/server/uol-init";

/** 以稳定的错误 DTO 编码下载路由拒绝或降级响应。 */
function errorResponse(error: string, code: string, status: number): Response {
  return Response.json({ error, code }, { status });
}

/** 将 AsyncIterable 转换为 Web ReadableStream，并在客户端断开时取消底层读取。 */
function toReadableStream(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let iteratorClosed = false;

  /** 只归还一次底层迭代器，避免 cancel 与在途 pull 竞态重复清理。 */
  async function closeIterator(): Promise<void> {
    if (iteratorClosed) return;
    iteratorClosed = true;
    await iterator.return?.();
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted) {
        await closeIterator();
        controller.close();
        return;
      }
      try {
        const next = await iterator.next();
        if (next.done) {
          iteratorClosed = true;
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        try {
          await closeIterator();
        } finally {
          controller.error(error);
        }
      }
    },
    async cancel() {
      await closeIterator();
    },
  });
}

/** 从 session 构造 Principal 并把 UOL 返回的进程内字节流编码为 CSV 响应。 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user)
    return errorResponse("Unauthorized", "unauthenticated", 401);
  if (session.user.banned) return errorResponse("Forbidden", "forbidden", 403);
  const { taskId } = await context.params;
  try {
    await ensureUolInitialized();
    const result =
      await invokeOperation<OperationsOpenLocalExportDownloadOutput>(
        "operations.openLocalExportDownload",
        { taskId },
        {
          type: "user",
          userId: session.user.id,
          role: await getUserRoleById(session.user.id),
        },
        {
          externalRequestId: request.headers.get("x-request-id") ?? undefined,
        }
      );
    return new Response(toReadableStream(result.stream, request.signal), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof OperationError) {
      return errorResponse(error.message, error.code, error.httpStatus);
    }
    logError(error, {
      source: "operations-export-local-download",
      taskId,
    });
    return errorResponse("Export unavailable", "unavailable", 503);
  }
}
