/**
 * 视频模型计费设置的 DB-free 聚合规则。
 *
 * 使用方：系统设置运行时读取、初始化与视频任务事务内权威报价。模块只规范化三项
 * JSON 设置和可信自定义模型描述，不导入数据库或缓存，保证所有入口使用同一补齐规则。
 */
import {
  createDefaultVideoModelBillingModes,
  createDefaultVideoModelCreditsPerItem,
  DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoPricingResolutionKey,
  type VideoBillingModelPricingDescriptor,
  type VideoModelBillingModes,
  type VideoModelCreditPrices,
  videoModelBillingModesSchema,
  videoModelCreditPricesSchema,
} from "../adobe/video-pricing";

/** 三项视频计费设置的聚合结果；调用方必须把它们作为同一个配置事实消费。 */
export type VideoModelBillingSettings = {
  readonly billingModes: VideoModelBillingModes;
  readonly creditsPerSecond: VideoModelCreditPrices;
  readonly creditsPerItem: VideoModelCreditPrices;
};

/**
 * 按模型广场中的既有自定义视频模型补齐三套计费设置。
 *
 * @param input - 三项未知设置值与已校验的自定义视频模型描述。
 * @returns 保留全部合法历史键，并补齐内置和自定义模型缺失项的新对象。
 * @sideEffects 无。
 * @throws ZodError - 任一已存在的新设置含非法模式或非正价格时 fail closed。
 */
export function normalizeVideoModelBillingSettings(input: {
  billingModes: unknown;
  creditsPerSecond: unknown;
  creditsPerItem: unknown;
  customModels?: readonly VideoBillingModelPricingDescriptor[];
}): VideoModelBillingSettings {
  const customModels = input.customModels ?? [];
  const parsedModes =
    input.billingModes === undefined
      ? {}
      : videoModelBillingModesSchema.parse(input.billingModes);
  const parsedPerSecond =
    input.creditsPerSecond === undefined
      ? {}
      : videoModelCreditPricesSchema.parse(input.creditsPerSecond);
  const parsedPerItem =
    input.creditsPerItem === undefined
      ? {}
      : videoModelCreditPricesSchema.parse(input.creditsPerItem);
  const billingModes = {
    ...createDefaultVideoModelBillingModes(customModels),
    ...parsedModes,
  };
  const creditsPerSecond: VideoModelCreditPrices = {
    ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
    ...parsedPerSecond,
  };
  for (const model of customModels) {
    const modelPrice =
      parsedPerSecond[model.modelId] ?? DEFAULT_VIDEO_BASE_CREDITS_PER_SECOND;
    for (const resolution of model.supportedResolutions) {
      const key = getVideoPricingResolutionKey(model.modelId, resolution);
      creditsPerSecond[key] ??= modelPrice;
    }
  }
  return {
    billingModes,
    creditsPerSecond,
    creditsPerItem: {
      ...createDefaultVideoModelCreditsPerItem(customModels),
      ...parsedPerItem,
    },
  };
}
