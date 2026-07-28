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

/** 管理员单次上传 Logo 的原始文件上限；multipart 额外开销由 Route 单独预留。 */
export const MAX_SITE_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 管理员上传声明可使用的 MIME；真实格式仍由服务端检查文件魔数。 */
export const SITE_LOGO_UPLOAD_MIME_TYPES = [
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

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

/** 管理员 Logo 上传的传输无关输入；文件名和 MIME 只用于前置反馈，不作为格式真相。 */
export const siteLogoUploadInputSchema = z
  .object({
    clientRequestId: z.string().uuid("上传请求标识无效"),
    fileName: z
      .string()
      .trim()
      .min(1, "Logo 文件名不能为空")
      .max(255, "Logo 文件名最多 255 个字符"),
    contentType: z.string().trim().max(100, "Logo MIME 类型过长"),
    bytes: z
      .custom<Uint8Array>(
        (value) => value instanceof Uint8Array,
        "Logo 文件字节无效"
      )
      .refine((value) => value.byteLength > 0, "Logo 文件不能为空")
      .refine(
        (value) => value.byteLength <= MAX_SITE_LOGO_UPLOAD_BYTES,
        "Logo 文件不能超过 5 MB"
      ),
  })
  .strict();

/** 管理员 Logo 上传的严格输入类型。 */
export type SiteLogoUploadInput = z.infer<typeof siteLogoUploadInputSchema>;

/** 上传成功输出；文件保持原格式，replayed 表示命中已持久化的幂等回执。 */
export const siteLogoUploadOutputSchema = siteBrandingSchema
  .extend({ replayed: z.boolean() })
  .strict();

/** 管理员 Logo 上传的严格输出类型。 */
export type SiteLogoUploadOutput = z.infer<typeof siteLogoUploadOutputSchema>;

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
