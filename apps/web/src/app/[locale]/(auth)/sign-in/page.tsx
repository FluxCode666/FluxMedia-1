/**
 * 本地化登录页面的服务端数据边界。
 *
 * 使用方是 `/[locale]/sign-in` 路由；本页面收窄未受信任的 callbackUrl 后再交给客户端
 * 表单，避免邮箱或 Google 登录形成开放重定向。
 */
import { loadAuthOptions } from "@/features/auth/auth-options";
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { resolveSafeAuthCallbackUrl } from "@/features/auth/safe-callback-url";

/**
 * 渲染本地化登录表单。
 *
 * @param props - 路由 locale 与查询参数。
 * @returns 携带安全 callbackUrl 和 Google 能力开关的登录表单。
 * @sideEffects 读取 Go 公开认证能力；不执行认证或导航。
 * @failure 非法 callbackUrl 由纯函数回退当前语言 dashboard。
 */
export default async function SignInPage({
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

  return (
    <SignInForm
      callbackUrl={callbackUrl}
      googleAuthEnabled={options.googleEnabled}
    />
  );
}
