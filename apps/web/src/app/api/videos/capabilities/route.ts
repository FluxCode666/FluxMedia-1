/**
 * 站内视频能力查询的 UOL 薄传输路由。
 *
 * 职责：从 Cookie session 构造用户 Principal 并调用 video.listCapabilities；能力、
 * 动态 Seedance 上限、分组可达性与输出过滤均由统一 operation 执行层负责。
 */

import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ensureUolInitialized } from "@/server/uol-init";

/**
 * 查询当前站内用户可见的视频模型有效能力。
 *
 * @param request - 携带 Better Auth session 与可选请求追踪 ID 的同源请求。
 * @returns no-store 公共能力 DTO；未登录或 UOL 稳定错误映射为对应 HTTP 状态。
 * @sideEffects 只读取 session、角色、系统能力覆盖和可信分组配置。
 * @failure 未登录返回 401；OperationError 保留稳定 code 与 httpStatus。
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureUolInitialized();
    const result = await invokeOperation(
      "video.listCapabilities",
      {},
      {
        type: "user",
        userId: session.user.id,
        role: await getUserRoleById(session.user.id),
      },
      {
        externalRequestId:
          request.headers.get("x-request-id") ?? undefined,
      }
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
