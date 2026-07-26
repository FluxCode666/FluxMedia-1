/**
 * 模型配置 multipart 保存请求的专用 Origin 校验。
 *
 * 使用方是 `/api/admin/model-configuration`；该 Route 使用 Cookie 会话并接收破坏性配置与
 * 封面输入，因此必须在读取正文和鉴权查询前只接受站点受信 HTTP(S) Origin。本模块 DB-free。
 */

type ModelConfigurationOriginEnvironment = {
  BETTER_AUTH_URL?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
};

/**
 * 读取模型配置来源校验所需的运行时环境变量。
 *
 * @returns 当前进程中的 Better Auth 主站和附加受信来源文本。
 * @sideEffects 只读访问 process.env，不修改运行时环境。
 * @failure 不抛错；缺失设置保持 undefined，由信任集合规则决定是否采用本地同源回退。
 */
function getRuntimeOriginEnvironment(): ModelConfigurationOriginEnvironment {
  return {
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_TRUSTED_ORIGINS: process.env.BETTER_AUTH_TRUSTED_ORIGINS,
  };
}

/**
 * 将一个 URL 或 Origin 严格收敛为可比较的 HTTP(S) origin。
 *
 * @param value - 部署配置、请求 URL 或浏览器 Origin 头中的原始文本。
 * @returns 标准化的 HTTP(S) origin；opaque、非法或其他协议返回 null。
 * @sideEffects 无。
 * @failure URL 解析异常被收窄为 null，调用方据此失败关闭。
 */
function normalizeModelConfigurationOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * 取得模型配置保存请求允许使用的唯一 Origin 集合。
 *
 * 已配置 Better Auth 主站或附加来源时，只信任其中合法的 HTTP(S) 静态配置，避免攻击者
 * 伪造 Host 让请求 URL 成为信任来源；仅完全未配置时回退请求 URL，保留本地动态端口。
 *
 * @param request - 后续管理保存 Route 收到的原始 Request。
 * @param environment - 可注入的来源环境；缺省读取当前进程运行时设置。
 * @returns 去重且标准化的受信 Origin 新集合。
 * @sideEffects 缺省参数只读访问 process.env；不读取请求正文、Cookie 或数据库。
 * @failure 配置存在但全部非法时返回空集合，不回退请求 Host。
 */
export function getTrustedModelConfigurationOrigins(
  request: Request,
  environment: ModelConfigurationOriginEnvironment = getRuntimeOriginEnvironment()
): Set<string> {
  const configuredValues = [
    environment.BETTER_AUTH_URL,
    ...(environment.BETTER_AUTH_TRUSTED_ORIGINS ?? "").split(","),
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);

  if (configuredValues.length > 0) {
    return new Set(
      configuredValues
        .map(normalizeModelConfigurationOrigin)
        .filter((origin): origin is string => origin !== null)
    );
  }

  const requestOrigin = normalizeModelConfigurationOrigin(request.url);
  return requestOrigin ? new Set([requestOrigin]) : new Set();
}

/**
 * 判断 Cookie 鉴权的模型配置保存请求是否来自受信站点。
 *
 * @param request - 尚未读取正文的管理保存 Request。
 * @param environment - 可注入的来源环境；缺省读取当前进程运行时设置。
 * @returns Origin 存在、合法且命中受信集合时为 true，否则为 false。
 * @sideEffects 缺省参数只读访问 process.env；不读取正文或触发会话、UOL 与存储调用。
 * @failure 缺失、null、格式错误、非 HTTP(S) 或跨站 Origin 一律返回 false，不抛出解析错误。
 */
export function hasTrustedModelConfigurationOrigin(
  request: Request,
  environment: ModelConfigurationOriginEnvironment = getRuntimeOriginEnvironment()
): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return false;

  const origin = normalizeModelConfigurationOrigin(originHeader);
  if (!origin) return false;

  return getTrustedModelConfigurationOrigins(request, environment).has(origin);
}
