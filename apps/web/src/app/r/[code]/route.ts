/**
 * 推广短链入口。
 *
 * 使用方：公开邀请链接 `/r/:code`。这里只验证并保存公开推广码，然后 303 跳转到
 * 本地化注册页；不会据推广码读取用户身份或执行奖励发放。
 */

import { resolvePublicAppUrl } from "@repo/shared/config";
import { normalizeReferralCode } from "@repo/shared/referrals/contract";
import { REFERRAL_CODE_COOKIE } from "@repo/shared/referrals/cookie";
import { NextResponse } from "next/server";

/** 保存合法推广码 30 天并跳转注册；非法码直接跳转且不写 cookie。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code: rawCode } = await params;
  const code = normalizeReferralCode(rawCode);
  const cookieLocale = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("NEXT_LOCALE="))
    ?.slice("NEXT_LOCALE=".length);
  const locale =
    cookieLocale === "en" || cookieLocale === "zh"
      ? cookieLocale
      : request.headers.get("accept-language")?.toLowerCase().startsWith("en")
        ? "en"
        : "zh";
  const redirectOrigin = resolvePublicAppUrl([
    process.env.BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    request.url,
  ]);
  const url = new URL(`/${locale}/sign-up`, `${redirectOrigin}/`);
  const response = NextResponse.redirect(url, 303);
  if (code) {
    response.cookies.set(REFERRAL_CODE_COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
    });
  }
  return response;
}
