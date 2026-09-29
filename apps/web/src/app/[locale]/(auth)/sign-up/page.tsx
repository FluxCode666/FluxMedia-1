/**
 * 本地化注册页面的服务端数据边界。
 *
 * 使用方是 `/[locale]/sign-up` 路由；本页面收窄未受信任的 callbackUrl 后再交给客户端
 * 表单，自用模式跳回登录页时也保留同一安全目标。
 */

import { redirect } from "@repo/shared/platform/navigation";
import { loadAuthOptions } from "@/features/auth/auth-options";
import { SignUpForm } from "@/features/auth/components/sign-up-form";
import { resolveSafeAuthCallbackUrl } from "@/features/auth/safe-callback-url";

/**
 * 渲染本地化注册表单，或在自用模式下安全跳回登录页。
 *
 * @param props - 路由 locale 与查询参数。
 * @returns 携带安全 callbackUrl 和 Google 能力开关的注册表单。
 * @sideEffects 读取 Go 公开认证能力；自用模式会触发路由重定向。
 * @failure 非法 callbackUrl 统一回退当前语言 dashboard。
 */
export default async function SignUpPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const [{ locale }, query, options] = await Promise.all([
    params,
    searchParams,
    loadAuthOptions(),
  ]);
  const callbackUrl = resolveSafeAuthCallbackUrl(query.callbackUrl, locale);

  if (options.selfUseMode) {
    redirect(
      `/${locale}/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`
    );
  }

  return (
    <SignUpForm
      callbackUrl={callbackUrl}
      googleAuthEnabled={options.googleEnabled}
    />
  );
}
