/**
 * 外部视频能力发现的 UOL 薄适配器。
 *
 * 职责：认证 API Key、构造 Principal 并调用 video.listCapabilities；输出由 UOL
 * 公共 DTO 约束，不读取或投影成员、凭据、健康与实时容量。
 */

import { withApiLogging } from "@repo/shared/api-logger";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import type { NextRequest } from "next/server";
import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import { openAIImageError } from "@/features/external-api/images";
import { ensureUolInitialized } from "@/server/uol-init";

/** 查询当前外部 API Key 可见的视频模型有效能力。 */
export const getExternalVideoCapabilities = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIImageError(
        "Invalid or missing API key",
        401,
        "invalid_api_key"
      );
    }
    try {
      await ensureUolInitialized();
      const result = await invokeOperation(
        "video.listCapabilities",
        {},
        {
          type: "apiKey",
          credentialKind: "external",
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
        },
        {
          externalRequestId:
            request.headers.get("x-request-id") ?? undefined,
        }
      );
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof OperationError) {
        return openAIImageError(error.message, error.httpStatus, error.code);
      }
      throw error;
    }
  }
);
