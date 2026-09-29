/**
 * 认证页面的公开能力开关。
 *
 * 使用方：登录页与注册页。Google OAuth 是否配置、自用模式是否关闭公开注册都由
 * Go backend 判定；凭据本身不会下发到浏览器。
 */
import { requestGoJson } from "@/lib/go-backend-request";

export type AuthOptions = {
  googleEnabled: boolean;
  selfUseMode: boolean;
};

/**
 * 读取认证页面能力开关。
 *
 * @returns Google 入口与自用模式开关。
 * @failure 请求失败时隐藏 Google 入口并展示表单；注册与 OAuth 仍由 Go 端最终拒绝。
 */
export async function loadAuthOptions(): Promise<AuthOptions> {
  try {
    const options = await requestGoJson<Partial<AuthOptions> | null>("/api/auth/options");
    return {
      googleEnabled: options?.googleEnabled === true,
      selfUseMode: options?.selfUseMode === true,
    };
  } catch {
    return { googleEnabled: false, selfUseMode: false };
  }
}
