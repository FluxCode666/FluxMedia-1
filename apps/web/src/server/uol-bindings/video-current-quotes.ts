/**
 * 视频能力价格发现的生产报价加载器。
 *
 * 使用方：video.listCapabilities 与模型目录的登录用户投影。模块用一次数据库 statement
 * 固定 Principal 分组和三项计费设置，再为每个模型分辨率签发互相隔离的报价 token。
 */
import { resolveModelMarketplaceEntry } from "@repo/shared/model-marketplace";
import {
  projectVideoCurrentQuote,
  type VideoCurrentQuote,
} from "@repo/shared/video-generation";
import {
  createVideoQuoteDigest,
  encodeVideoQuoteToken,
} from "@repo/shared/video-generation/video-quote-token";

import type {
  VideoCapabilityConfiguredModelsInput,
  VideoCapabilityPricingDescriptor,
} from "./video-generation-capabilities";

/**
 * 为当前 Principal 的全部公开视频模型加载按分辨率当前报价。
 *
 * @param selection - 用户、API Key、可信分组和签名主体作用域。
 * @param models - 已由能力或目录层确认可公开的模型及支持分辨率。
 * @returns 以模型 ID 为键、每个分辨率各有独立 token 的当前报价。
 * @sideEffects 执行一次权威数据库读取，并读取 BETTER_AUTH_SECRET 签名 token。
 * @throws 分组、设置、模式、价格、模型或 secret 非法时 fail closed。
 */
export async function loadVideoCurrentQuotes(
  selection: VideoCapabilityConfiguredModelsInput & {
    principalScope: string;
  },
  models: readonly VideoCapabilityPricingDescriptor[]
): Promise<Readonly<Record<string, readonly VideoCurrentQuote[]>>> {
  const [{ db }, runtime] = await Promise.all([
    import("@repo/database"),
    import("@/features/image-backend-pool/runtime-service"),
  ]);
  const context = await runtime.resolveAuthoritativeRuntimeVideoPricingContext(
    selection,
    {
      execute: (query) => db.execute(query),
    }
  );
  return Object.fromEntries(
    models.map((model) => {
      const modelConfigurationRevision = resolveModelMarketplaceEntry(
        context.marketplaceConfig.videoByFamily[model.modelId],
        "video"
      ).revision;
      return [
        model.modelId,
        model.supportedResolutions.map((resolution) => {
          const quote = runtime.resolveRuntimeVideoQuoteFromContext(context, {
            modelId: model.modelId,
            resolution,
            // token 绑定单位价格；首次创建仍按请求时长在权威事务内计算总价。
            durationSeconds: 1,
          });
          const quoteToken = encodeVideoQuoteToken({
            principalScope: selection.principalScope,
            quoteDigest: createVideoQuoteDigest({
              modelId: quote.modelId,
              resolution: quote.resolution,
              mode: quote.mode,
              unitPrice: quote.unitPrice,
              billingGroupId: context.pinnedGroupId,
              modelConfigurationRevision,
            }),
          });
          return projectVideoCurrentQuote(quote, quoteToken);
        }),
      ];
    })
  );
}
