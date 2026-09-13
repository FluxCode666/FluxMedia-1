import { headers } from "next/headers";

type BackendSession = {
  session?: Record<string, unknown>;
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
    role?: string | null;
    banned?: boolean | null;
    bannedReason?: string | null;
    [key: string]: unknown;
  };
} | null;

/**
 * 服务器端获取当前用户会话
 *
 * 用于 Server Components 和 Server Actions 中获取用户信息
 *
 * @example
 * ```tsx
 * // 在 Server Component 中使用
 * export default async function Page() {
 *   const session = await getServerSession();
 *   if (!session) {
 *     redirect("/sign-in");
 *   }
 *   return <div>Welcome, {session.user.name}</div>;
 * }
 * ```
 */
export async function getServerSession() {
  const incoming = await headers();
  const cookie = incoming.get("cookie");
  const base = (process.env.GO_BACKEND_URL || "http://127.0.0.1:8080").replace(/\/$/u, "");
  const init: RequestInit = { cache: "no-store" };
  if (cookie) init.headers = { cookie };
  const response = await fetch(`${base}/api/session/current?disableSessionRefresh=true`, init);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return null;
    throw new Error(`Go session request failed (${response.status})`);
  }
  return (await response.json()) as BackendSession;
}

/**
 * 获取当前用户
 *
 * 便捷方法，直接返回用户对象或 null
 */
export async function getCurrentUser() {
  const session = await getServerSession();
  return session?.user ?? null;
}

/**
 * 检查用户是否已认证
 *
 * @returns boolean - 用户是否已登录
 */
export async function isAuthenticated() {
  const session = await getServerSession();
  return !!session?.user;
}
