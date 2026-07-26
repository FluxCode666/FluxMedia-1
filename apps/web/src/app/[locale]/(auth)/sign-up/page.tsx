/**
 * 本地化注册页面的服务端数据边界。
 *
 * 使用方是 `/[locale]/sign-up` 路由；本页面收窄未受信任的 callbackUrl 后再交给客户端
 * 表单，自用模式跳回登录页时也保留同一安全目标。
 */

import { isSelfUseModeEnabled } from "@repo/shared/auth/self-use-mode";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { resolveSafeAuthCallbackUrl } from "@/features/auth/safe-callback-url";

/**
 * 判断生产环境是否完整配置 Google OAuth。
 *
 * @returns 客户端是否应展示 Google 注册入口。
 * @sideEffects 只读取当前服务端进程环境变量。
 * @failure 任一凭据缺失时安全返回 false，不暴露凭据内容。
 */
function isGoogleAuthEnabled() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
}

/**
 * 渲染本地化注册表单，或在自用模式下安全跳回登录页。
 *
 * @param props - Next.js 异步 locale 与查询参数。
 * @returns 携带安全 callbackUrl 和 Google 能力开关的注册表单。
 * @sideEffects 读取自用模式设置与服务端环境；自用模式会抛出 Next.js redirect。
 * @failure 非法 callbackUrl 统一回退当前语言 dashboard。
 */
export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const [{ locale }, query, selfUseModeEnabled] = await Promise.all([
    params,
    searchParams,
    isSelfUseModeEnabled(),
  ]);
  const callbackUrl = resolveSafeAuthCallbackUrl(query.callbackUrl, locale);

  if (selfUseModeEnabled) {
    redirect(
      `/${locale}/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`
    );
  }

  return (
    <SignUpForm
      callbackUrl={callbackUrl}
      googleAuthEnabled={isGoogleAuthEnabled()}
    />
  );
}
