/**
 * 本地化登录页面的服务端数据边界。
 *
 * 使用方是 `/[locale]/sign-in` 路由；本页面收窄未受信任的 callbackUrl 后再交给客户端
 * 表单，避免邮箱或 Google 登录形成开放重定向。
 */
import { SignInForm } from "@/features/auth/components/sign-in-form";
import { resolveSafeAuthCallbackUrl } from "@/features/auth/safe-callback-url";

/**
 * 判断生产环境是否完整配置 Google OAuth。
 *
 * @returns 客户端是否应展示 Google 登录入口。
 * @sideEffects 只读取当前服务端进程环境变量。
 * @failure 任一凭据缺失时安全返回 false，不暴露凭据内容。
 */
function isGoogleAuthEnabled() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
}

/**
 * 渲染本地化登录表单。
 *
 * @param props - Next.js 异步 locale 与查询参数。
 * @returns 携带安全 callbackUrl 和 Google 能力开关的登录表单。
 * @sideEffects 读取服务端环境变量；不执行认证或导航。
 * @failure 非法 callbackUrl 由纯函数回退当前语言 dashboard。
 */
export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams]);
  const callbackUrl = resolveSafeAuthCallbackUrl(query.callbackUrl, locale);

  return (
    <SignInForm
      callbackUrl={callbackUrl}
      googleAuthEnabled={isGoogleAuthEnabled()}
    />
  );
}
