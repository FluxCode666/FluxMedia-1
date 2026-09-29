/**
 * 当前登录会话读取。
 *
 * 使用方：页面与布局加载函数、受保护 Action。会话由 Go 根据 HttpOnly Cookie 判定；
 * 同一次路由渲染内的并发调用共享一个请求，路由切换或刷新后重新读取。
 */

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

/** 同一渲染轮次复用会话请求的最长时间；超过后即使未切换路由也重新读取。 */
const SESSION_REUSE_MS = 2_000;

let cached: { epoch: number; at: number; promise: Promise<BackendSession> } | null = null;
let sessionEpoch = 0;

/** 让后续调用重新读取会话；路由切换、刷新与登录态变化后调用。 */
export function invalidateServerSession(): void {
  sessionEpoch += 1;
  cached = null;
}

async function fetchSession(): Promise<BackendSession> {
  const response = await fetch("/api/session/current?disableSessionRefresh=true", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return null;
    throw new Error(`Go session request failed (${response.status})`);
  }
  return (await response.json()) as BackendSession;
}

/**
 * 获取当前用户会话；未登录返回 null，后端不可用时抛错。
 *
 * @example
 * ```tsx
 * export default async function Page() {
 *   const session = await getServerSession();
 *   if (!session) redirect("/sign-in");
 *   return <div>Welcome, {session.user.name}</div>;
 * }
 * ```
 */
export function getServerSession(): Promise<BackendSession> {
  const now = Date.now();
  if (cached && cached.epoch === sessionEpoch && now - cached.at < SESSION_REUSE_MS) {
    return cached.promise;
  }
  const entry = { epoch: sessionEpoch, at: now, promise: fetchSession() };
  cached = entry;
  entry.promise.catch(() => {
    if (cached === entry) cached = null;
  });
  return entry.promise;
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
