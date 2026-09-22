/** Rate-limit transport and HTTP formatting. Go owns configuration, counters and admission. */
import { requestGoBackendInternalJson } from "../http/go-backend";
import type { NextRequest } from "next/server";

const RATE_LIMIT_DEFINITIONS = {
  global: {
    settingKey: "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE",
    fallback: 100,
  },
  auth: {
    settingKey: "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE",
    fallback: 5,
  },
  ai: {
    settingKey: "RATE_LIMIT_AI_REQUESTS_PER_MINUTE",
    fallback: 20,
  },
  payment: {
    settingKey: "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE",
    fallback: 10,
  },
  upload: {
    settingKey: "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE",
    fallback: 30,
  },
  strict: {
    settingKey: "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE",
    fallback: 3,
  },
} as const;

export type RateLimitType = keyof typeof RATE_LIMIT_DEFINITIONS;

function getPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

/**
 * 兼容既有调用方的进程环境配置视图。
 * 业务限流不使用该静态视图，而是在每次检查时读取缓存后的运行时设置。
 */
export const RateLimitConfig = {
  global: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_GLOBAL_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.global.fallback
      );
    },
    window: "1m" as const,
  },
  auth: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_AUTH_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.auth.fallback
      );
    },
    window: "1m" as const,
  },
  ai: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_AI_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.ai.fallback
      );
    },
    window: "1m" as const,
  },
  payment: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_PAYMENT_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.payment.fallback
      );
    },
    window: "1m" as const,
  },
  upload: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_UPLOAD_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.upload.fallback
      );
    },
    window: "1m" as const,
  },
  strict: {
    get requests() {
      return getPositiveIntegerEnv(
        "RATE_LIMIT_STRICT_REQUESTS_PER_MINUTE",
        RATE_LIMIT_DEFINITIONS.strict.fallback
      );
    },
    window: "1m" as const,
  },
} as const;

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number;
  limit: number;
  skipped: boolean;
}

/** Forward a session-bound dashboard check to the authenticated Go service. */
export async function checkRateLimit(identifier: string, type: RateLimitType = "global"): Promise<RateLimitResult> {
  return requestGoBackendInternalJson<RateLimitResult>("/api/internal/rate-limit", {
    method: "POST",
    body: JSON.stringify({ identifier, type }),
  });
}

function isTrustedProxyEnabled(): boolean {
  const value = process.env.RATE_LIMIT_TRUSTED_PROXY?.trim().toLowerCase();
  // 仅 "false" / "0" / "no" 显式关闭；未配置时保持向后兼容（默认信任）。
  return value !== "false" && value !== "0" && value !== "no";
}

/**
 * 从 NextRequest 获取客户端 IP，用作 per-IP 限流标识。
 *
 * @param request - 入站请求
 * @returns 客户端 IP 字符串；无可信来源时返回固定兜底标识
 *
 * 取值优先级：cf-connecting-ip → x-real-ip → x-forwarded-for 最左字段。
 * 前两者为受信反代设置的单值头；x-forwarded-for 最左字段由客户端可控，
 * 故放在最后兜底。这些头都不是天然防伪造的——仅在前置可信反代覆盖写时可信
 * （见 isTrustedProxyEnabled）。未声明可信代理时全部忽略，回退固定兜底标识，
 * 避免攻击者伪造头轮换 IP 旁路限流。
 */
export function getClientIp(request: NextRequest): string {
  if (!isTrustedProxyEnabled()) {
    // 无可信前置代理：所有转发头均不可信，统一归并到固定标识。
    // per-IP 限流在此降级为整体限流，宁可误伤共享出口也不被伪造头旁路。
    return "untrusted-proxy";
  }

  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) {
    return cfIp;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  }

  return "unknown";
}

/**
 * 生成限流响应头
 */
export function getRateLimitHeaders(result: RateLimitResult): HeadersInit {
  if (result.skipped) {
    return {};
  }

  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
  };
}

/**
 * 创建 429 Too Many Requests 响应
 */
export function createRateLimitResponse(result: RateLimitResult): Response {
  const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);

  return new Response(
    JSON.stringify({
      error: "Too Many Requests",
      message: "请求过于频繁，请稍后再试",
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        ...getRateLimitHeaders(result),
      },
    }
  );
}

// ============================================
// 高级 API：带限流的请求处理
// ============================================

/**
 * 限流包装器选项
 */
export interface WithRateLimitOptions {
  /** 限流类型 */
  type?: RateLimitType;
  /** 自定义标识符获取函数 */
  getIdentifier?: (request: NextRequest) => string | Promise<string>;
}

/**
 * 限流中间件包装器
 *
 * @example
 * ```ts
 * export async function POST(request: NextRequest) {
 *   return withRateLimit(request, { type: "auth" }, async () => {
 *     // 你的业务逻辑
 *     return NextResponse.json({ success: true });
 *   });
 * }
 * ```
 */
export async function withRateLimit<T extends Response>(
  request: NextRequest,
  options: WithRateLimitOptions,
  handler: () => Promise<T>
): Promise<T | Response> {
  const { type = "global", getIdentifier = getClientIp } = options;

  const identifier = await getIdentifier(request);
  const result = await checkRateLimit(identifier, type);

  if (!result.success) {
    return createRateLimitResponse(result);
  }

  const response = await handler();

  // 添加限流头到响应
  const headers = getRateLimitHeaders(result);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}
