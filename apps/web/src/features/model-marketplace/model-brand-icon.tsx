/**
 * 模型广场与模型配置共享的本地品牌图标组件。
 *
 * 使用方是管理列表、编辑弹窗、公开模型卡片和详情；图标路径只来自 Task 4 许可可追溯的
 * 本地资产映射，未知模型使用 generic，不请求第三方 CDN。
 */
import type { ModelMarketplaceIconKey } from "@repo/shared/model-marketplace";
import { cn } from "@repo/ui/utils";
import Image from "next/image";

import { getModelMarketplaceIconPath } from "./assets";

export type ModelBrandIconProps = {
  iconKey: ModelMarketplaceIconKey;
  className?: string;
  size?: number;
};

/**
 * 渲染当前模型的本地品牌兼容标识。
 *
 * @param props - iconKey、可选尺寸与样式；图标为装饰性，模型 ID 承担可访问名称。
 * @returns 固定正方形且不变形的 Next Image。
 * @sideEffects 浏览器按第一方静态路径读取 SVG。
 * @failure 静态资产异常时由外层布局保留固定尺寸，不猜测其他品牌。
 */
export function ModelBrandIcon({
  iconKey,
  className,
  size = 20,
}: ModelBrandIconProps) {
  return (
    <Image
      src={getModelMarketplaceIconPath(iconKey)}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={cn("shrink-0 object-contain", className)}
      unoptimized
    />
  );
}
