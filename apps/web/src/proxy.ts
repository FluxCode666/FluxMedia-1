/**
 * Next.js 请求代理。
 *
 * 使用方：Next.js 16 在 Node.js Runtime 中自动执行。负责版本化静态资源重写、
 * API 动态限流、国际化路由和登录态页面保护；限流配置经系统设置缓存运行时读取。
 */
import {
  checkRateLimit,
  createRateLimitResponse,
  getClientIp,
  getRateLimitHeaders,
} from "@repo/shared/rate-limit";
import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";
import { getApiRateLimitType } from "./rate-limit-routing";

/** 创建国际化请求处理器，无外部副作用。 */
const intlMiddleware = createIntlMiddleware(routing);
const VERSIONED_ASSET_PREFIX_PATTERN =
  /^\/(?:gpt2-assets|next-assets)-[^/]+(\/_next\/.*)$/;

/**
 * 为认证相关响应设置禁止共享缓存的响应头。
 *
 * @param response - 待修改的 Next.js 响应。
 * @returns 同一响应实例；副作用是覆盖缓存相关响应头，不会失败。
 */
function setPrivateNoStore(response: NextResponse) {
  response.headers.set(
    "Cache-Control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

/**
 * 处理进入应用的请求。
 *
 * 功能：
 * 1. API 限流（全局 + 路由级别）
 * 2. 国际化路由处理（next-intl）
 * 3. 认证保护（Better Auth）
 *    - /dashboard/* 需要登录才能访问
 *    - 未登录用户将被重定向到 /sign-in
 *
 * @param request - Next.js 传入的请求。
 * @returns 重写、重定向、限流拒绝或继续处理的响应。
 * @sideEffects 限流路径可能访问 Redis/PostgreSQL；依赖故障由限流模块降级。
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (VERSIONED_ASSET_PREFIX_PATTERN.test(pathname)) {
    const rewrittenUrl = request.nextUrl.clone();
    rewrittenUrl.pathname = pathname.replace(
      /^\/(?:gpt2-assets|next-assets)-[^/]+/,
      ""
    );
    return NextResponse.rewrite(rewrittenUrl);
  }

  // ============================================
  // API 路由限流
  // ============================================
  if (pathname.startsWith("/api/")) {
    // 跳过健康检查和 webhook（webhook 需要验证签名，不应被限流阻断）
    if (pathname === "/api/health" || pathname.startsWith("/api/webhooks/")) {
      return NextResponse.next();
    }

    if (
      pathname.startsWith("/api/auth/") ||
      pathname === "/api/session/current"
    ) {
      return setPrivateNoStore(NextResponse.next());
    }

    // 白名单模式：只对匹配的敏感路由做限流
    const rateLimitType = getApiRateLimitType(pathname);
    if (rateLimitType) {
      const ip = getClientIp(request);
      const result = await checkRateLimit(ip, rateLimitType);

      if (!result.success) {
        return createRateLimitResponse(result);
      }

      const response = NextResponse.next();
      const headers = getRateLimitHeaders(result);
      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
      return pathname.startsWith("/api/auth/") ||
        pathname === "/api/session/current"
        ? setPrivateNoStore(response)
        : response;
    }

    // 未匹配的 API 路由直接放行，不触发 Redis
    return NextResponse.next();
  }

  if (pathname === "/moderate") {
    return NextResponse.next();
  }

  if (pathname.startsWith("/v1/")) {
    const rateLimitType = getApiRateLimitType(pathname);
    if (rateLimitType) {
      const ip = getClientIp(request);
      const result = await checkRateLimit(ip, rateLimitType);

      if (!result.success) {
        return createRateLimitResponse(result);
      }

      const response = NextResponse.next();
      const headers = getRateLimitHeaders(result);
      for (const [key, value] of Object.entries(headers)) {
        response.headers.set(key, value);
      }
      return response;
    }

    return NextResponse.next();
  }

  // ============================================
  // 非 API 路由：国际化 + 认证保护
  // ============================================

  // 获取 Better Auth 的 session token
  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value ||
    request.cookies.get("__Secure-better-auth.session_token")?.value;

  // 从路径中提取不带语言前缀的路径
  // 例如: /en/dashboard -> /dashboard, /zh/sign-in -> /sign-in
  const pathnameWithoutLocale = pathname.replace(/^\/(en|zh)/, "") || "/";

  // 定义需要保护的路由
  const protectedRoutes = ["/dashboard"];

  // 定义认证页面路由 (已登录用户不应访问)
  const authRoutes = ["/sign-in", "/sign-up"];

  // 检查当前路径是否是受保护的路由
  const isProtectedRoute = protectedRoutes.some(
    (route) =>
      pathnameWithoutLocale === route ||
      pathnameWithoutLocale.startsWith(`${route}/`)
  );

  // 检查当前路径是否是认证页面
  const isAuthRoute = authRoutes.some(
    (route) => pathnameWithoutLocale === route
  );

  // 获取当前语言前缀 (用于重定向)
  const localeMatch = pathname.match(/^\/(en|zh)/);
  const locale = localeMatch ? localeMatch[1] : routing.defaultLocale;

  // 如果访问受保护路由但未登录，重定向到登录页
  if (isProtectedRoute && !sessionToken) {
    const signInUrl = new URL(`/${locale}/sign-in`, request.url);
    // 查询参数包含模型广场的一次性预选意图，必须与路径一起进入服务端安全收窄边界。
    signInUrl.searchParams.set(
      "callbackUrl",
      `${pathname}${request.nextUrl.search}`
    );
    return setPrivateNoStore(NextResponse.redirect(signInUrl));
  }

  // 执行国际化中间件
  const response = intlMiddleware(request);
  return isProtectedRoute || isAuthRoute
    ? setPrivateNoStore(response)
    : response;
}

/**
 * 代理匹配配置
 *
 * 现在也匹配 API 路由，以便进行全局限流
 */
export const config = {
  matcher: [
    /*
     * 匹配所有路径除了:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files
     *
     * 注意: 现在包含 /api 路由以便进行限流
     */
    "/((?!_next/static|_next/image|favicon.ico|site\\.webmanifest|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
