/**
 * 认证页面 Logo 组件。
 *
 * 职责：为登录、注册等认证页面展示统一动态图标和品牌文字。
 * 使用方：登录与注册表单。
 * 关键依赖：全站 SiteLogo 组件。
 */
import { SiteLogo } from "@/features/branding/site-logo";

/**
 * 渲染认证页面品牌标识。
 *
 * @returns 动态 Logo 与 FluxMedia 文本组合。
 * @sideEffects 浏览器通过 SiteLogo 请求公共 Logo 路由。
 */
export function AuthLogo() {
  return (
    <div className="flex items-center gap-2">
      <SiteLogo size={28} className="shrink-0" alt="" />
      <span className="font-serif text-xl font-medium tracking-tight">
        FluxMedia
      </span>
    </div>
  );
}
