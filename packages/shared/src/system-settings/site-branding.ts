/**
 * 站点品牌配置契约。
 *
 * 职责：校验管理员配置的 Logo 地址，并为运行时读取提供稳定默认值。
 * 使用方：系统设置写入门、站点品牌 UOL operation 与管理后台预览。
 * 关键边界：只接受第一方根路径或 HTTPS 地址，拒绝主动内容协议与重定向递归。
 */
import { z } from "zod";

/** 未配置、配置损坏或读取失败时使用的内置矢量 Logo。 */
export const DEFAULT_SITE_LOGO_URL = "/assets/icon.svg";

/** 前台统一引用的动态 Logo 路由；配置值不能再次指向本路由。 */
export const SITE_LOGO_ROUTE_PATH = "/api/site-logo";

/**
 * 添加统一的 Logo 地址校验错误。
 *
 * @param ctx - 当前 Zod 精炼上下文。
 * @returns 无返回值。
 * @sideEffects 向校验上下文追加一条稳定中文错误，不暴露 URL 解析器细节。
 */
function addSiteLogoUrlIssue(ctx: z.RefinementCtx): void {
  ctx.addIssue({
    code: "custom",
    message: "Logo 地址仅支持站内根路径或不含账号凭据的 HTTPS 地址",
  });
}

/**
 * 判断路径是否包含明文或编码后的父目录段。
 *
 * @param value - 尚未信任的 Logo 地址草稿。
 * @returns 包含父目录段或百分号编码损坏时返回 true。
 * @sideEffects 无。
 */
function containsParentDirectorySegment(value: string): boolean {
  try {
    return decodeURIComponent(value)
      .split(/[/?#]/)
      .some((segment) => segment === "..");
  } catch {
    return true;
  }
}

/**
 * 判断地址是否包含 URL 不应接受的 ASCII 控制字符。
 *
 * @param value - 尚未信任的 Logo 地址草稿。
 * @returns 包含 U+0000 至 U+001F 或 U+007F 时返回 true。
 * @sideEffects 无。
 */
function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

/**
 * 管理员可配置的 Logo 地址。
 *
 * @returns 去除首尾空白后的第一方根路径或 HTTPS URL。
 * @failure 协议相对地址、HTTP、账号凭据、反斜杠、父目录和递归路由均校验失败。
 */
export const siteLogoUrlSchema = z
  .string()
  .trim()
  .min(1, "Logo 地址不能为空")
  .max(2048, "Logo 地址最多 2048 个字符")
  .superRefine((value, ctx) => {
    if (
      value.includes("\\") ||
      containsAsciiControlCharacter(value) ||
      containsParentDirectorySegment(value) ||
      value.startsWith("//")
    ) {
      addSiteLogoUrlIssue(ctx);
      return;
    }

    let parsed: URL;
    try {
      parsed = value.startsWith("/")
        ? new URL(value, "https://site.invalid")
        : new URL(value);
    } catch {
      addSiteLogoUrlIssue(ctx);
      return;
    }

    const isFirstPartyPath =
      value.startsWith("/") && parsed.origin === "https://site.invalid";
    const isSafeHttpsUrl =
      !value.startsWith("/") &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "";
    if (!isFirstPartyPath && !isSafeHttpsUrl) {
      addSiteLogoUrlIssue(ctx);
      return;
    }

    if (
      parsed.pathname === "/" ||
      parsed.pathname === SITE_LOGO_ROUTE_PATH ||
      parsed.pathname.startsWith(`${SITE_LOGO_ROUTE_PATH}/`)
    ) {
      addSiteLogoUrlIssue(ctx);
    }
  });

/** 公开站点品牌 DTO，仅包含页面渲染需要的安全字段。 */
export const siteBrandingSchema = z
  .object({
    logoUrl: siteLogoUrlSchema,
  })
  .strict();

/** 公开站点品牌 DTO 类型。 */
export type SiteBranding = z.infer<typeof siteBrandingSchema>;

/**
 * 把不可信的运行时设置收窄为可公开渲染的 Logo 地址。
 *
 * @param value - 数据库或部署环境读取出的未知值。
 * @returns 合法配置；缺失或脏值统一回退内置矢量 Logo。
 * @sideEffects 无。
 */
export function resolveSiteLogoUrl(value: unknown): string {
  const parsed = siteLogoUrlSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SITE_LOGO_URL;
}
