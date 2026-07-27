/**
 * 登录与注册回跳 URL 的服务端安全收窄器。
 *
 * 使用方是本地化认证页面；本模块只允许当前语言的 dashboard 子树，阻止开放重定向、
 * 路径规范化逃逸与响应拆分字符，并把合法无语言前缀路径统一补成站内本地化路径。
 */
const CALLBACK_ORIGIN = "https://auth-callback.invalid";
const DEFAULT_AUTH_LOCALE = "en";
const AUTH_LOCALES = ["en", "zh"] as const;
const ENCODED_UNSAFE_CHARACTER_PATTERN =
  /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f|8[0-9a-f]|9[0-9a-f])/i;

/**
 * 检查原始 callback 是否含 C0、DEL 或 C1 控制字符。
 *
 * @param value - 未受信任的 callback 字符串。
 * @returns 任一 Unicode code point 位于控制字符范围时为 true。
 * @sideEffects 无。
 * @failure 不抛错；字符串迭代按完整 code point 处理代理对。
 */
function hasRawControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 把路由参数收窄为受支持的语言。
 *
 * @param currentLocale - Next.js 动态路由提供的未知语言文本。
 * @returns 匹配的受支持语言；无效值使用项目默认语言。
 * @sideEffects 无。
 * @failure 不抛错，未知语言始终安全回退。
 */
function resolveSupportedLocale(currentLocale: string): string {
  return (
    AUTH_LOCALES.find((locale) => locale === currentLocale) ??
    DEFAULT_AUTH_LOCALE
  );
}

/**
 * 判断路径是否严格位于 dashboard 路由树。
 *
 * @param pathname - URL 解析器规范化后的绝对路径。
 * @returns 仅 `/dashboard` 本身或以 `/dashboard/` 开头时为 true。
 * @sideEffects 无。
 * @failure 不抛错；`/dashboard-evil` 等伪前缀返回 false。
 */
function isDashboardPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
}

/**
 * 判断原始路径是否包含点段，防止 URL 规范化把白名单路径逃逸后再伪装成合法路径。
 *
 * @param rawPathname - 尚未交给 URL 解析器规范化的路径部分。
 * @returns 原始或百分号编码路径包含 `.`、`..` 段时为 true。
 * @sideEffects 无。
 * @failure 非法百分号编码按不安全处理，不向调用方抛错。
 */
function hasUnsafePathSegment(rawPathname: string): boolean {
  try {
    return decodeURIComponent(rawPathname)
      .split("/")
      .some((segment) => segment === "." || segment === "..");
  } catch {
    return true;
  }
}

/**
 * 将认证 callback 查询参数收窄为当前语言的站内 dashboard 路径。
 *
 * @param callbackUrl - 未受信任的查询参数；数组、空值与非字符串均拒绝。
 * @param currentLocale - 当前认证页语言；无效值使用项目默认语言。
 * @returns 保留合法查询参数的本地化绝对路径；任一校验失败则返回语言 dashboard 首页。
 * @sideEffects 无，不读取请求、会话或浏览器状态。
 * @failure 所有非法输入均 fail-closed，不抛错或返回站外 URL。
 */
export function resolveSafeAuthCallbackUrl(
  callbackUrl: unknown,
  currentLocale: string
): string {
  const locale = resolveSupportedLocale(currentLocale);
  const fallback = `/${locale}/dashboard`;
  if (typeof callbackUrl !== "string" || callbackUrl.length === 0) {
    return fallback;
  }
  if (
    callbackUrl !== callbackUrl.trim() ||
    !callbackUrl.startsWith("/") ||
    callbackUrl.startsWith("//") ||
    callbackUrl.includes("\\") ||
    callbackUrl.includes("#") ||
    hasRawControlCharacter(callbackUrl) ||
    ENCODED_UNSAFE_CHARACTER_PATTERN.test(callbackUrl)
  ) {
    return fallback;
  }

  const queryStart = callbackUrl.indexOf("?");
  const rawPathname =
    queryStart === -1 ? callbackUrl : callbackUrl.slice(0, queryStart);
  if (hasUnsafePathSegment(rawPathname)) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl, CALLBACK_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== CALLBACK_ORIGIN) return fallback;

  const localizedDashboardPrefix = `/${locale}`;
  if (parsed.pathname.startsWith(`${localizedDashboardPrefix}/`)) {
    const unlocalizedPathname = parsed.pathname.slice(
      localizedDashboardPrefix.length
    );
    return isDashboardPath(unlocalizedPathname)
      ? `${parsed.pathname}${parsed.search}`
      : fallback;
  }

  return isDashboardPath(parsed.pathname)
    ? `/${locale}${parsed.pathname}${parsed.search}`
    : fallback;
}
