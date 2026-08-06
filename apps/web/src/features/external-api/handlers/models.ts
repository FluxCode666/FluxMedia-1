import { withApiLogging } from "@repo/shared/api-logger";
import { invokeOperation, OperationError } from "@repo/shared/uol";
import { type NextRequest, NextResponse } from "next/server";

import { authenticateExternalApiRequest } from "@/features/external-api/auth";
import type { OpenAIModelList } from "@/features/external-api/models";
import { ensureUolInitialized } from "@/server/uol-init";

function openAIError(message: string, status = 400, code?: string) {
  return NextResponse.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        code: code || null,
      },
    },
    { status }
  );
}

export const getExternalModels = withApiLogging(
  async (request: NextRequest) => {
    const auth = await authenticateExternalApiRequest(request);
    if (!auth) {
      return openAIError("Invalid or missing API key", 401, "invalid_api_key");
    }
    try {
      await ensureUolInitialized();
      const models = await invokeOperation<OpenAIModelList>(
        "externalApi.getModels",
        {},
        {
          type: "apiKey",
          credentialKind: "external",
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
        }
      );
      return NextResponse.json(models, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      if (error instanceof OperationError) {
        return openAIError(error.message, error.httpStatus, error.code);
      }
      throw error;
    }
  }
);
