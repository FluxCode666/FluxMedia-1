/**
 * Adobe 图片适配器的公开模型 ID 解析。
 *
 * 职责：将 Firefly 和裸 Nano Banana 图片能力键解析为上游家族；
 * 本函数只在命中 Adobe 成员后构造协议载荷，不参与调度候选过滤。
 */
import {
  type AdobeImageFamily,
  isAdobeImageFamilyModelId,
} from "@repo/shared/adobe";

/** Adobe 图片适配器支持的上游家族。 */
export const ADOBE_IMAGE_FAMILIES: AdobeImageFamily[] = [
  "gpt-image-2",
  "gpt-image-1.5",
  "nano-banana",
  "nano-banana2",
  "nano-banana-pro",
];

/**
 * 从公开模型 ID 解析 Adobe 上游图片家族。
 *
 * @param modelId Firefly 或裸 Nano Banana 能力键。
 * @returns 最长前缀命中的家族；非 Adobe 图片能力时返回 null。
 */
export function pickAdobeFamilyFromModel(
  modelId: string | null | undefined
): AdobeImageFamily | null {
  const normalized = String(modelId ?? "")
    .trim()
    .toLowerCase();
  const hasFireflyPrefix = normalized.startsWith("firefly-");
  const isBareNanoBanana =
    !hasFireflyPrefix &&
    isAdobeImageFamilyModelId(normalized) &&
    normalized.startsWith("nano-banana");
  if (!hasFireflyPrefix && !isBareNanoBanana) return null;

  const candidate = hasFireflyPrefix
    ? normalized.slice("firefly-".length)
    : normalized;
  for (const family of [...ADOBE_IMAGE_FAMILIES].sort(
    (left, right) => right.length - left.length
  )) {
    if (candidate === family || candidate.startsWith(`${family}-`)) {
      return family;
    }
  }
  return null;
}
