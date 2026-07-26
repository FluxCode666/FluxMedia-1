/**
 * 图像尺寸校验、分辨率档位和积分计算的纯函数。
 *
 * 创作页、统一生图管线、营销页与账单页共同依赖本模块，确保预估与最终结算使用
 * 同一套尺寸和价格规则；运行时模型价格和审核费用由 pricing-settings 注入。
 */

import {
  DEFAULT_IMAGE_CREDIT_PRICING,
  DEFAULT_IMAGE_MODERATION_CREDIT_PRICING,
  type ImageCreditPricing,
} from "@repo/shared/image-backend/group-image-pricing";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
export const LEGACY_IMAGE_MODEL = "gpt-image-1";
export const IMAGE_MODEL_PREFIX = "gpt-image-";
// Adobe Firefly（直连/网关）图像模型统一前缀；按模型前缀自动路由到 adobe 后端。
export const FIREFLY_MODEL_PREFIX = "firefly-";
export const IMAGE_PROMPT_MAX_CHARACTERS = 32_000;
export const IMAGE_PROMPT_TOO_LONG_MESSAGE = `Prompt exceeds the ${IMAGE_PROMPT_MAX_CHARACTERS} character limit.`;
export const AUTO_IMAGE_SIZE = "auto";
export const IMAGE_1K_BASE_EDGE = 1248;
export const IMAGE_1K_BASE_SIZE = `${IMAGE_1K_BASE_EDGE}x${IMAGE_1K_BASE_EDGE}`;
export const DEFAULT_IMAGE_SIZE = "1024x1024";
export const IMAGE_DIMENSION_STEP = 16;
export const MIN_IMAGE_DIMENSION = 256;
export const MAX_IMAGE_DIMENSION = 3840;
export const MAX_IMAGE_ASPECT_RATIO = 3;
export const MIN_IMAGE_PIXELS = 655360;
export const MAX_IMAGE_PIXELS = 3840 * 2160;
export const IMAGE_1024_BASE_PIXELS = 1024 * 1024;
export const IMAGE_2K_BASE_EDGE = 2048;
export const IMAGE_4K_BASE_EDGE = 3840;
export const DEFAULT_IMAGE_1024_BASE_CREDIT_COST =
  DEFAULT_IMAGE_CREDIT_PRICING.base1024Credits;
export const DEFAULT_IMAGE_1K_BASE_CREDIT_COST =
  DEFAULT_IMAGE_CREDIT_PRICING.base1kCredits;
// 保留旧曲线在 2048x2048 的向上取整结果，切换固定档位时避免常用 2K 方图突变。
export const DEFAULT_IMAGE_2K_BASE_CREDIT_COST =
  DEFAULT_IMAGE_CREDIT_PRICING.base2kCredits;
export const DEFAULT_IMAGE_4K_BASE_CREDIT_COST =
  DEFAULT_IMAGE_CREDIT_PRICING.base4kCredits;
export const IMAGE_4K_BASE_CREDIT_COST = DEFAULT_IMAGE_4K_BASE_CREDIT_COST;
export const REFERENCE_CREDIT_PRICE_CNY = 0.05;
export const TEXT_MODERATION_PRICE_CNY = 0.002;
export const IMAGE_MODERATION_PRICE_CNY = 0.003;
export const DEFAULT_TEXT_MODERATION_CREDIT_COST =
  DEFAULT_IMAGE_MODERATION_CREDIT_PRICING.textModerationCredits;
export const DEFAULT_IMAGE_MODERATION_CREDIT_COST =
  DEFAULT_IMAGE_MODERATION_CREDIT_PRICING.imageModerationCredits;
const CREDIT_DECIMAL_PLACES = 2;
const CREDIT_DECIMAL_FACTOR = 10 ** CREDIT_DECIMAL_PLACES;
const CREDIT_ROUNDING_EPSILON = 1e-9;

export type ImageDimensions = {
  width: number;
  height: number;
};

export function normalizeImageModel(model?: string | null) {
  const requested = model?.trim();
  if (!requested || requested === LEGACY_IMAGE_MODEL) return undefined;
  return requested;
}

export function isImageModel(model?: string | null) {
  const normalizedModel = normalizeImageModel(model)?.toLowerCase();
  return Boolean(
    normalizedModel?.startsWith(IMAGE_MODEL_PREFIX) ||
      normalizedModel?.startsWith(FIREFLY_MODEL_PREFIX)
  );
}

// 是否 Adobe Firefly 模型（按前缀）。用于创作页/接口在 firefly 模型时切换到 adobe 专属
// 参数（宽高比/分辨率），并隐藏 gpt 专属选项。
export function isFireflyModel(model?: string | null) {
  return Boolean(
    normalizeImageModel(model)?.toLowerCase().startsWith(FIREFLY_MODEL_PREFIX)
  );
}

export function getImageModel(model?: string | null, fallback?: string | null) {
  const requested = normalizeImageModel(model);
  if (requested) {
    return isImageModel(requested) ? requested : null;
  }

  const fallbackModel = normalizeImageModel(fallback);
  if (fallbackModel && isImageModel(fallbackModel)) return fallbackModel;

  return DEFAULT_IMAGE_MODEL;
}

/**
 * 解析 API 池后端的图像模型。
 *
 * API 池是管理员明确配置的受信任上游转发边界，不能用平台模型白名单限制它。
 * 此函数仅负责模型标识透传，不代表该上游一定支持
 * 此模型；实际兼容性由后端测活与上游响应决定。
 *
 * @param model - 调用方显式请求的模型。
 * @param fallback - API 后端配置的默认模型。
 * @returns 首个非空模型；两者都为空时回退平台默认模型。
 */
export function getImageBackendApiModel(
  model?: string | null,
  fallback?: string | null
) {
  return (
    normalizeImageModel(model) ||
    normalizeImageModel(fallback) ||
    DEFAULT_IMAGE_MODEL
  );
}

export const IMAGE_RESOLUTION_PRESETS = [
  { value: AUTO_IMAGE_SIZE, label: "Auto", detail: "Backend decides" },
  { value: IMAGE_1K_BASE_SIZE, label: "1K Square", detail: "1248 × 1248" },
  { value: "1536x1024", label: "Landscape", detail: "1536 × 1024" },
  { value: "1024x1536", label: "Portrait", detail: "1024 × 1536" },
  { value: "2048x2048", label: "2K Square", detail: "2048 × 2048" },
  { value: "2048x1152", label: "2K Wide", detail: "2048 × 1152" },
  { value: "3840x2160", label: "4K Wide", detail: "3840 × 2160" },
  { value: "2160x3840", label: "4K Tall", detail: "2160 × 3840" },
] as const;

/**
 * 质量等级仅作为上游请求参数，不参与本站积分计费。
 */
export const QUALITY_MULTIPLIER: Record<string, number> = {
  low: 1.0,
  medium: 1.0,
  high: 1.0,
  auto: 1.0,
} as const;

/**
 * 思考/推理等级仅作为上游请求参数，不参与本站积分计费。
 */
export const THINKING_MULTIPLIER: Record<string, number> = {
  none: 1.0,
  minimal: 1.0,
  low: 1.0,
  medium: 1.0,
  high: 1.0,
  xhigh: 1.0,
} as const;

export type ImageQualityLevel = "low" | "medium" | "high" | "auto";
export type ImageThinkingLevel =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export type ImageCreditCostOptions = {
  textModerationCount?: number;
  imageModerationCount?: number;
  basePricing?: ImageBaseCreditPricing;
  moderationPricing?: ImageModerationCreditPricing;
  /** 图像质量等级，仅用于保留计价明细兼容字段，不影响积分。 */
  quality?: ImageQualityLevel | null;
  /** 思考/推理等级，仅用于保留计价明细兼容字段，不影响积分。 */
  thinking?: ImageThinkingLevel | null;
};

export type ImageBaseCreditPricing = ImageCreditPricing;

export type ImageModerationCreditPricing = {
  textModerationCredits?: number;
  imageModerationCredits?: number;
};

export type ResolvedImageModerationCreditPricing = {
  textModerationCredits: number;
  imageModerationCredits: number;
};

export function roundCreditAmount(value: number) {
  return (
    Math.round((value + Number.EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

export function roundUpCreditAmount(value: number) {
  return (
    Math.ceil((value - CREDIT_ROUNDING_EPSILON) * CREDIT_DECIMAL_FACTOR) /
    CREDIT_DECIMAL_FACTOR
  );
}

function normalizeBaseCreditPrice(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** 将审核积分收窄为非负有限数；非法值回退默认费用。 */
function normalizeModerationCreditPrice(value: unknown, fallback: number) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function getImageBaseCreditPricing(
  pricing?: ImageBaseCreditPricing | null
) {
  return {
    base1024Credits: normalizeBaseCreditPrice(
      pricing?.base1024Credits,
      DEFAULT_IMAGE_1024_BASE_CREDIT_COST
    ),
    base1kCredits: normalizeBaseCreditPrice(
      pricing?.base1kCredits,
      DEFAULT_IMAGE_1K_BASE_CREDIT_COST
    ),
    base2kCredits: normalizeBaseCreditPrice(
      pricing?.base2kCredits,
      DEFAULT_IMAGE_2K_BASE_CREDIT_COST
    ),
    base4kCredits: normalizeBaseCreditPrice(
      pricing?.base4kCredits,
      DEFAULT_IMAGE_4K_BASE_CREDIT_COST
    ),
  };
}

/**
 * 取得文本与输入图片审核的单次积分费用。
 *
 * @param pricing - 管理员运行时配置；允许显式设为 0。
 * @returns 可直接按审核次数相加的非负积分价格。
 */
export function getImageModerationCreditPricing(
  pricing?: ImageModerationCreditPricing | null
): ResolvedImageModerationCreditPricing {
  return {
    textModerationCredits: normalizeModerationCreditPrice(
      pricing?.textModerationCredits,
      DEFAULT_TEXT_MODERATION_CREDIT_COST
    ),
    imageModerationCredits: normalizeModerationCreditPrice(
      pricing?.imageModerationCredits,
      DEFAULT_IMAGE_MODERATION_CREDIT_COST
    ),
  };
}

/**
 * 按输出最长边取得固定的图像基础积分。
 *
 * @param dimensions - 已解析的输出宽高；缺失或非法时按 4K 价格 fail-closed。
 * @param pricing - 管理员配置的 1024、1K、2K、4K 基础价格。
 * @returns 未叠加审核费用的模型基础积分。
 */
export function getImageBaseCredits(
  dimensions: ImageDimensions | null | undefined,
  pricing?: ImageBaseCreditPricing | null
) {
  const longestEdge = Math.max(
    dimensions?.width ?? Number.NaN,
    dimensions?.height ?? Number.NaN
  );
  const { base1024Credits, base1kCredits, base2kCredits, base4kCredits } =
    getImageBaseCreditPricing(pricing);

  // WHY: 分辨率等级由最长边定义，才能让 2048x1152 和 2048x2048 等同属 2K
  // 的输出获得相同价格；按总像素会让相同分辨率档因宽高比不同而出现不同价格。
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) {
    return base4kCredits;
  }
  if (longestEdge >= IMAGE_4K_BASE_EDGE) return base4kCredits;
  if (longestEdge >= IMAGE_2K_BASE_EDGE) return base2kCredits;
  if (longestEdge >= IMAGE_1K_BASE_EDGE) return base1kCredits;
  return base1024Credits;
}

/**
 * 质量不再影响积分；保留函数用于历史明细和调用方兼容。
 */
export function getQualityMultiplier(
  _quality?: ImageQualityLevel | null
): number {
  return 1.0;
}

/**
 * 思考强度不再影响积分；保留函数用于历史明细和调用方兼容。
 */
export function getThinkingMultiplier(
  _thinking?: ImageThinkingLevel | null
): number {
  return 1.0;
}

export function getImageCreditCostBreakdown(
  size?: string | null,
  options: ImageCreditCostOptions = {}
) {
  const normalizedSize = size || DEFAULT_IMAGE_SIZE;
  const dimensions =
    parseImageSize(normalizedSize) || parseImageSize(DEFAULT_IMAGE_SIZE);
  const pixels = dimensions
    ? dimensions.width * dimensions.height
    : MAX_IMAGE_PIXELS;
  const baseCredits = getImageBaseCredits(dimensions, options.basePricing);

  // 质量和思考强度仅影响上游请求，不再影响本站积分。
  const qualityMultiplier = getQualityMultiplier(options.quality);
  const thinkingMultiplier = getThinkingMultiplier(options.thinking);
  const effectiveBaseCredits =
    baseCredits * qualityMultiplier * thinkingMultiplier;

  const textModerationCount = options.textModerationCount ?? 1;
  const imageModerationCount = options.imageModerationCount ?? 0;
  const moderationPricing = getImageModerationCreditPricing(
    options.moderationPricing
  );
  const textModerationCredits =
    textModerationCount * moderationPricing.textModerationCredits;
  const imageModerationCredits =
    imageModerationCount * moderationPricing.imageModerationCredits;
  const moderationCredits = textModerationCredits + imageModerationCredits;
  const moderationCny = moderationCredits * REFERENCE_CREDIT_PRICE_CNY;
  const totalCredits = roundUpCreditAmount(
    effectiveBaseCredits + moderationCredits
  );
  const moderationOnlyCredits =
    moderationCredits > 0 ? roundUpCreditAmount(moderationCredits) : 0;

  return {
    baseCredits: roundUpCreditAmount(effectiveBaseCredits),
    effectiveBaseCredits: roundUpCreditAmount(effectiveBaseCredits),
    imageModerationCount,
    imageModerationCredits: roundCreditAmount(imageModerationCredits),
    moderationCny,
    moderationCredits: roundCreditAmount(moderationCredits),
    moderationOnlyCredits,
    pixels,
    qualityMultiplier,
    textModerationCount,
    textModerationCredits: roundCreditAmount(textModerationCredits),
    thinkingMultiplier,
    totalCredits,
  };
}

export function getImageCreditCost(
  size?: string | null,
  options: ImageCreditCostOptions = {}
) {
  return getImageCreditCostBreakdown(size, options).totalCredits;
}

export function parseImageSize(size: string): ImageDimensions | null {
  const match = size
    .trim()
    .toLowerCase()
    .match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;

  return { width, height };
}

export function isOneKImageSize(size?: string | null) {
  if (!size || size.trim().toLowerCase() === AUTO_IMAGE_SIZE) return false;
  const dimensions = parseImageSize(size);
  if (!dimensions) return false;
  return Math.max(dimensions.width, dimensions.height) <= IMAGE_1K_BASE_EDGE;
}

export function getImageSizePixels(size?: string | null) {
  if (!size || size.trim().toLowerCase() === AUTO_IMAGE_SIZE) return null;
  const dimensions = parseImageSize(size);
  if (!dimensions) return null;
  return dimensions.width * dimensions.height;
}

export function isImageSizeWithinPixelRange(
  size: string | null | undefined,
  minPixels: number,
  maxPixels: number
) {
  const pixels = getImageSizePixels(size);
  if (pixels === null) return false;
  const lower = Math.min(minPixels, maxPixels);
  const upper = Math.max(minPixels, maxPixels);
  return pixels >= lower && pixels <= upper;
}

export function normalizeImageSize(width: number, height: number) {
  return `${width}x${height}`;
}

function clampDimension(value: number) {
  return Math.min(MAX_IMAGE_DIMENSION, Math.max(MIN_IMAGE_DIMENSION, value));
}

function roundToImageStep(value: number) {
  return Math.round(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

function ceilToImageStep(value: number) {
  return Math.ceil(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

function floorToImageStep(value: number) {
  return Math.floor(value / IMAGE_DIMENSION_STEP) * IMAGE_DIMENSION_STEP;
}

function enforceMaxAspectRatio(dimensions: ImageDimensions): ImageDimensions {
  let width = dimensions.width;
  let height = dimensions.height;

  if (width > height * MAX_IMAGE_ASPECT_RATIO) {
    height = ceilToImageStep(width / MAX_IMAGE_ASPECT_RATIO);
  } else if (height > width * MAX_IMAGE_ASPECT_RATIO) {
    width = ceilToImageStep(height / MAX_IMAGE_ASPECT_RATIO);
  }

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(
      MAX_IMAGE_DIMENSION / width,
      MAX_IMAGE_DIMENSION / height
    );
    width = floorToImageStep(width * scale);
    height = floorToImageStep(height * scale);
  }

  return {
    width: clampDimension(width),
    height: clampDimension(height),
  };
}

function growToMinPixels(dimensions: ImageDimensions): ImageDimensions {
  let width = dimensions.width;
  let height = dimensions.height;

  if (width * height < MIN_IMAGE_PIXELS) {
    const scale = Math.sqrt(MIN_IMAGE_PIXELS / (width * height));
    width = clampDimension(ceilToImageStep(width * scale));
    height = clampDimension(ceilToImageStep(height * scale));
  }

  ({ width, height } = enforceMaxAspectRatio({ width, height }));

  while (width * height < MIN_IMAGE_PIXELS) {
    const canGrowWidth =
      width < MAX_IMAGE_DIMENSION &&
      (width + IMAGE_DIMENSION_STEP) / height <= MAX_IMAGE_ASPECT_RATIO;
    const canGrowHeight =
      height < MAX_IMAGE_DIMENSION &&
      (height + IMAGE_DIMENSION_STEP) / width <= MAX_IMAGE_ASPECT_RATIO;

    if (!canGrowWidth && !canGrowHeight) break;

    if ((width <= height && canGrowWidth) || !canGrowHeight) {
      width += IMAGE_DIMENSION_STEP;
    } else {
      height += IMAGE_DIMENSION_STEP;
    }
  }

  return { width, height };
}

export function fitImageDimensionsToValidSize(
  dimensions: ImageDimensions
): ImageDimensions {
  const originalWidth = Math.max(1, dimensions.width);
  const originalHeight = Math.max(1, dimensions.height);
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_IMAGE_PIXELS / (originalWidth * originalHeight))
  );
  const maxScale = Math.min(
    MAX_IMAGE_DIMENSION / originalWidth,
    MAX_IMAGE_DIMENSION / originalHeight,
    pixelScale
  );
  const scaledWidth = originalWidth * maxScale;
  const scaledHeight = originalHeight * maxScale;
  let width = clampDimension(roundToImageStep(scaledWidth));
  let height = clampDimension(roundToImageStep(scaledHeight));

  ({ width, height } = enforceMaxAspectRatio({ width, height }));

  while (width * height > MAX_IMAGE_PIXELS) {
    const widthOverflow = width / scaledWidth;
    const heightOverflow = height / scaledHeight;
    if (widthOverflow >= heightOverflow && width > MIN_IMAGE_DIMENSION) {
      width -= IMAGE_DIMENSION_STEP;
    } else if (height > MIN_IMAGE_DIMENSION) {
      height -= IMAGE_DIMENSION_STEP;
    } else {
      break;
    }
  }

  ({ width, height } = growToMinPixels({ width, height }));

  return {
    width: floorToImageStep(width),
    height: floorToImageStep(height),
  };
}

export function normalizeValidImageSize(dimensions: ImageDimensions) {
  const valid = fitImageDimensionsToValidSize(dimensions);
  return normalizeImageSize(valid.width, valid.height);
}

export function isValidImageDimension(value: number) {
  return (
    Number.isInteger(value) &&
    value >= MIN_IMAGE_DIMENSION &&
    value <= MAX_IMAGE_DIMENSION &&
    value % IMAGE_DIMENSION_STEP === 0
  );
}

export function validateImageSize(
  size: string
):
  | { valid: true; dimensions: ImageDimensions | null; auto: boolean }
  | { valid: false; message: string } {
  if (size.trim().toLowerCase() === AUTO_IMAGE_SIZE) {
    return { valid: true, dimensions: null, auto: true };
  }

  const dimensions = parseImageSize(size);
  if (!dimensions) {
    return { valid: false, message: "Use WIDTHxHEIGHT format." };
  }

  if (
    !isValidImageDimension(dimensions.width) ||
    !isValidImageDimension(dimensions.height)
  ) {
    return {
      valid: false,
      message: `Width and height must be between ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION}px and divisible by ${IMAGE_DIMENSION_STEP}.`,
    };
  }

  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    return {
      valid: false,
      message: `Total pixels must be no more than ${MAX_IMAGE_PIXELS.toLocaleString()}.`,
    };
  }

  if (dimensions.width * dimensions.height < MIN_IMAGE_PIXELS) {
    return {
      valid: false,
      message: `Total pixels must be at least ${MIN_IMAGE_PIXELS.toLocaleString()}.`,
    };
  }

  const longEdge = Math.max(dimensions.width, dimensions.height);
  const shortEdge = Math.min(dimensions.width, dimensions.height);
  if (longEdge / shortEdge > MAX_IMAGE_ASPECT_RATIO) {
    return {
      valid: false,
      message: `Aspect ratio must be no more than ${MAX_IMAGE_ASPECT_RATIO}:1.`,
    };
  }

  return { valid: true, dimensions, auto: false };
}
