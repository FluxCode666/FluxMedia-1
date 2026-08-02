/**
 * 模型广场内置中文简介的唯一事实源。
 *
 * 使用方包括公开模型目录与管理端模型配置草稿；首次只调整价格或能力时，管理端必须
 * 展示并保存同一简介，避免创建展示配置后意外清空公开文案。
 */

const BUILTIN_MODEL_MARKETPLACE_DESCRIPTIONS: Readonly<Record<string, string>> =
  {
    "gpt-image-2": "适合高质量图像生成、精细文字渲染与复杂指令遵循。",
    "gpt-image-1.5": "兼顾图像质量、编辑能力与稳定指令遵循。",
    "nano-banana-pro": "适合高质量图像创作、编辑与多元素一致性处理。",
    "nano-banana": "适合快速图像生成、编辑与日常创意探索。",
    "nano-banana2": "适合快速生成并保持稳定的视觉与提示词一致性。",
    sora2: "适合生成具有连贯运动和电影感构图的视频。",
    "sora2-pro": "适合对画面质量、运动细节与叙事一致性要求更高的视频。",
    veo31: "适合高质量视频生成与多种时长、比例和分辨率组合。",
    "veo31-ref": "适合基于参考图保持主体与视觉风格一致的视频生成。",
    "veo31-fast": "适合需要更快反馈的高质量视频创作。",
    "kling-o3": "适合强调动作表现、镜头运动与参考一致性的视频生成。",
    kling3: "适合多场景视频创作与稳定的运动表现。",
    "kling3-omni": "适合逐秒控制时长，并生成横屏或竖屏的高分辨率视频。",
    "runway-gen45": "适合生成 16:9 横屏电影感视频，并提供多档短时长选择。",
    ray314: "适合生成多画幅、高分辨率的电影感短视频。",
    "ray314-hdr": "适合生成高动态范围、多画幅的高分辨率电影感短视频。",
    seedance2: "适合使用参考图生成长时竖屏视频并保持视觉风格一致。",
    "seedance2-fast": "适合更快生成多画幅视频并保持参考图视觉风格一致。",
  };

/**
 * 读取真实模型配置键对应的内置公开简介。
 *
 * @param configKey - 已规范化的图像模型键或真实视频模型 ID。
 * @returns 已知模型的内置简介；未知模型返回空字符串供管理员自行填写。
 * @sideEffects 无。
 * @failure 不抛错；最终长度仍由管理或公开 DTO schema 复核。
 */
export function getBuiltinModelMarketplaceDescription(
  configKey: string
): string {
  return BUILTIN_MODEL_MARKETPLACE_DESCRIPTIONS[configKey] ?? "";
}
