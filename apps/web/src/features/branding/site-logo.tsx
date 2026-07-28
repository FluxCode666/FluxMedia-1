"use client";

/**
 * 全站统一 Logo 图片组件。
 *
 * 职责：把各页面的品牌图标统一指向动态 Logo 路由，并保持固定布局尺寸。
 * 使用方：营销 Header、首页页脚、认证页与 Dashboard 侧栏。
 * 关键依赖：Next Image；使用 unoptimized 让浏览器直接跟随动态 307 重定向。
 */
import Image from "next/image";

/**
 * 渲染当前网站 Logo。
 *
 * @param size - 正方形布局尺寸，单位为 CSS 像素。
 * @param className - 可选样式类，交由调用方控制收缩与视觉布局。
 * @param alt - 图片替代文本，默认使用站点名称。
 * @returns 指向动态同源路由的 Next Image。
 * @sideEffects 浏览器请求公共 Logo 路由；外部目标不发送 Referer。
 */
export function SiteLogo({
  size,
  className,
  alt = "FluxMedia",
}: {
  size: number;
  className?: string;
  alt?: string;
}) {
  return (
    <Image
      src="/api/site-logo"
      alt={alt}
      width={size}
      height={size}
      className={className}
      referrerPolicy="no-referrer"
      unoptimized
    />
  );
}
