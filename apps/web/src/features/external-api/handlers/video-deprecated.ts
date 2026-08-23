/** 已下线的视频创建地址处理器；明确拒绝，不回退到 generations。 */

import { withApiLogging } from "@repo/shared/api-logger";
import type { NextRequest } from "next/server";
import { openAIImageError } from "@/features/external-api/images";

export const postDeprecatedVideoGenerations = withApiLogging(
  async (_request: NextRequest) =>
    openAIImageError(
      "This video creation endpoint is deprecated; use POST /v1/videos/generations",
      410,
      "deprecated_endpoint"
    )
);
