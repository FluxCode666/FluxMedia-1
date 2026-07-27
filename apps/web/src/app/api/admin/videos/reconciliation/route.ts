/**
 * 视频提交不确定状态的管理员 HTTP 适配器。
 *
 * 职责：提供待核对任务列表，并把管理员结论薄适配到 UOL；不直接访问视频 service、
 * 财务或 Adobe。Cookie 写请求必须通过 same-origin 校验。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { auth } from "@repo/shared/auth";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";

import { hasTrustedImageGenerationOrigin } from "@/features/image-generation/request-security";
import { ensureUolInitialized } from "@/server/uol-init";

/** 将 UOL 错误编码为不泄露内部状态的管理接口响应。 */
function operationErrorResponse(error: OperationError): Response {
  return Response.json(
    { error: error.message, code: error.code },
    { status: error.httpStatus }
  );
}

/** 从会话构造真实管理员 Principal；权限最终仍由 UOL roles 门禁判定。 */
async function getSessionPrincipal(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return {
    type: "user" as const,
    userId: session.user.id,
    role: await getUserRoleById(session.user.id),
  };
}

/** 列出 submit_uncertain 任务的安全诊断字段。 */
export const GET = withApiLogging(async (request: NextRequest) => {
  const principal = await getSessionPrincipal(request);
  if (!principal) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rawLimit = request.nextUrl.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  try {
    await ensureUolInitialized();
    const result = await invokeOperation(
      "video.listUncertainSubmissions",
      { limit },
      principal,
      { requestId: request.headers.get("x-request-id") ?? undefined }
    );
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OperationError) return operationErrorResponse(error);
    throw error;
  }
});

/** 提交 accepted 或 not_accepted 人工核对结论。 */
export const POST = withApiLogging(async (request: NextRequest) => {
  const principal = await getSessionPrincipal(request);
  if (!principal) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasTrustedImageGenerationOrigin(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    await ensureUolInitialized();
    const result = await invokeOperation(
      "video.reconcileSubmission",
      body,
      principal,
      { requestId: request.headers.get("x-request-id") ?? undefined }
    );
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OperationError) return operationErrorResponse(error);
    throw error;
  }
});
