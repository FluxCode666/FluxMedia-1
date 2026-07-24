/**
 * 页面生图写请求的来源校验。
 *
 * 使用方：`/api/images/generate` 与 `/api/images/edit`。这两个接口使用浏览器
 * Cookie 会话，同时 Better Auth 为兼容部分 WebView 关闭了全局 CSRF 检查；因此在
 * 资金与算力消耗发生前，接口必须自行确认请求来自站点的受信 Origin。
 *
 * 依赖：仅依赖标准 Request 与运行时环境变量，保持 DB-free，供单测覆盖。
 */

type OriginEnvironment = {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

/** 只读取来源校验所需的环境变量，避免项目的窄 ProcessEnv 声明泄露到纯函数签名。 */
function getRuntimeOriginEnvironment(): OriginEnvironment {
  return {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  };
}

/**
 * 将一个 URL/Origin 收敛为可比较的 origin。
 *
 * @returns 合法且非 `null` 的标准 origin；无效或 opaque origin 返回 `null`。
 */
function normalizeOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * 取得页面写请求允许使用的 Origin 集合。
 *
 * 已配置 `BETTER_AUTH_URL` 或 `BETTER_AUTH_TRUSTED_ORIGINS` 时，只信任该静态
 * 配置，避免攻击者通过伪造 Host 让请求 URL 自身成为信任来源。开发环境未配置时，
 * 才回退到请求 URL 的 origin，以保留本地端口可变时的可用性。
 */
export function getTrustedImageGenerationOrigins(
  request: Request,
  environment: OriginEnvironment = getRuntimeOriginEnvironment()
): Set<string> {
  const configuredValues = [
    environment.BETTER_AUTH_URL,
    ...(environment.BETTER_AUTH_TRUSTED_ORIGINS || "").split(","),
  ]
    .map((value) => value?.trim() || "")
    .filter(Boolean);

  if (configuredValues.length > 0) {
    return new Set(
      configuredValues
        .map(normalizeOrigin)
        .filter((origin): origin is string => Boolean(origin))
    );
  }

  const requestOrigin = normalizeOrigin(request.url);
  return requestOrigin ? new Set([requestOrigin]) : new Set();
}

/**
 * 验证 Cookie 鉴权的页面生图写请求是否来自受信站点。
 *
 * 缺失、`null`、格式错误或不在白名单中的 Origin 都一律拒绝。页面端 `fetch` 会携带
 * Origin；没有 Origin 的脚本调用应使用独立的 Bearer 外部 API，而不是复用 Cookie
 * 路由，从而避免降级为仅依赖 SameSite 的 CSRF 防护。
 */
export function hasTrustedImageGenerationOrigin(
  request: Request,
  environment: OriginEnvironment = getRuntimeOriginEnvironment()
): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  const origin = normalizeOrigin(originHeader);
  if (!origin) return false;

  return getTrustedImageGenerationOrigins(request, environment).has(origin);
}
