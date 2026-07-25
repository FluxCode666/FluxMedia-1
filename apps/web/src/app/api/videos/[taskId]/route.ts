/**
 * 站内视频状态查询的 UOL 薄传输路由。
 *
 * 职责：从 Cookie session 构造用户 Principal 并委托 video.getStatus；任务归属、
 * 状态映射和签名 URL 均由统一 operation 执行层负责。
 */

import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureUolInitialized } from "@/server/uol-init";

/** 查询当前站内用户拥有的视频任务。 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { taskId } = await params;
  if (!taskId || taskId.length > 128) {
    return NextResponse.json({ error: "Invalid task id" }, { status: 400 });
  }
  try {
    await ensureUolInitialized();
    const result = await invokeOperation(
      "video.getStatus",
      { taskId },
      {
        type: "user",
        userId: session.user.id,
        role: await getUserRoleById(session.user.id),
      },
      { requestId: request.headers.get("x-request-id") ?? undefined }
    );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OperationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus }
      );
    }
    throw error;
  }
}
