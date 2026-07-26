/**
 * 首页快速集成的纯数据与安全示例构建器。
 *
 * 使用方：首页服务端组件与 Vitest。关键依赖：公开 API 文档的最小共享契约；本模块
 * 不读取请求 Host、转发头或 API Key，只接受已配置的 origin 和模型广场公开图像投影。
 */
import { getApiIntegrationHomepageContract } from "@/features/docs/api-integration-docs-data";
import { isConcretePlatformImageModelId } from "@/features/external-api/platform-model-catalog";

/** 构建器接受的单个公开图像模型。 */
export type HomepageIntegrationImageModel = { id: string };

/** 目录成功和目录读取失败必须保持可区分。 */
export type HomepageIntegrationCatalogState =
  | {
      status: "ready";
      image: readonly HomepageIntegrationImageModel[];
    }
  | { status: "unavailable" };

/** origin 校验需要的运行环境；生产不开放 HTTP 例外。 */
export type HomepageIntegrationRuntime = "development" | "production";

/** 不可生成示例时对页面公开的稳定原因。 */
export type HomepageIntegrationUnavailableReason =
  | "catalog_unavailable"
  | "no_image_model"
  | "unsafe_origin";

/** 首页可复制示例的纯构建器输入。 */
export type HomepageIntegrationExampleInput = {
  catalog: HomepageIntegrationCatalogState;
  origin: string;
  runtime: HomepageIntegrationRuntime;
};

/** 首页可复制示例或显式不可用状态。 */
export type HomepageIntegrationExample =
  | {
      status: "available";
      curl: string;
      endpointUrl: string;
      modelId: string;
      requestBody: string;
    }
  | {
      status: "unavailable";
      reason: HomepageIntegrationUnavailableReason;
    };

/** 首页快速集成中的单个服务端操作步骤。 */
export type HomepageIntegrationStep = {
  title: string;
  description: string;
};

/** 首页快速集成的完整可见文案与固定站内入口。 */
export type HomepageIntegrationContent = {
  eyebrow: string;
  title: string;
  description: string;
  steps: readonly [
    HomepageIntegrationStep,
    HomepageIntegrationStep,
    HomepageIntegrationStep,
  ];
  exampleTitle: string;
  modelLabel: string;
  endpointPath: string;
  copyLabels: {
    copy: string;
    copied: string;
    copyFailed: string;
  };
  links: {
    apiDocs: "/api-docs";
    apiKeys: "/dashboard/external-api";
  };
  linkLabels: {
    apiDocs: string;
    apiKeys: string;
  };
  unavailableTitle: string;
  unavailableMessages: Record<HomepageIntegrationUnavailableReason, string>;
};

/** 判断文本是否包含 URL 配置不应接受的 ASCII 控制字符。 */
function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

/** 判断 HTTP hostname 是否为无需 DNS 解析的明确 loopback。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

/**
 * 校验并规范化配置 origin。
 *
 * @param origin - 仅应来自 siteConfig 的外部输入，不接受请求 Host 或转发头。
 * @param runtime - 生产或开发协议策略。
 * @returns 去除末尾斜线的可信 origin；不安全时返回 null。
 * @sideEffects 无。
 * @failure URL 非法、含凭据/路径/query/fragment，或协议不满足环境策略时失败关闭。
 */
function normalizeTrustedOrigin(
  origin: string,
  runtime: HomepageIntegrationRuntime
): string | null {
  if (!origin || origin.trim() !== origin || containsControlCharacter(origin)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    return null;
  }
  if (url.protocol === "https:") return url.origin;
  if (
    runtime === "development" &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  ) {
    return url.origin;
  }
  return null;
}

/**
 * 将任意文本编码为单个 POSIX shell 参数。
 *
 * @param value - 可能包含引号、换行或命令替换符的动态文本。
 * @returns 使用单引号包裹并安全拆分内部单引号的 shell 片段。
 * @sideEffects 无。
 */
function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 从稳定目录顺序中选择第一个可执行的具体图像模型。 */
function findFirstConcreteImageModel(
  models: readonly HomepageIntegrationImageModel[]
): string | null {
  for (const model of models) {
    if (typeof model.id !== "string") continue;
    const id = model.id.trim();
    if (id.length <= 255 && isConcretePlatformImageModelId(id)) {
      return id;
    }
  }
  return null;
}

/**
 * 构建首页首次图片 API 请求。
 *
 * @param input - 配置 origin、运行环境与模型广场公开图像目录状态。
 * @returns 可安全复制的 cURL，或不携带 cURL 的显式 unavailable 状态。
 * @sideEffects 无。
 * @failure 目录失败、无具体模型或 origin 不可信时返回对应原因，不插入未验证值。
 */
export function buildHomepageIntegrationExample(
  input: HomepageIntegrationExampleInput
): HomepageIntegrationExample {
  if (input.catalog.status === "unavailable") {
    return { status: "unavailable", reason: "catalog_unavailable" };
  }
  const modelId = findFirstConcreteImageModel(input.catalog.image);
  if (!modelId) {
    return { status: "unavailable", reason: "no_image_model" };
  }
  const origin = normalizeTrustedOrigin(input.origin, input.runtime);
  if (!origin) {
    return { status: "unavailable", reason: "unsafe_origin" };
  }

  const contract = getApiIntegrationHomepageContract();
  const endpointUrl = `${origin}${contract.endpoint.path}`;
  const requestBody = JSON.stringify({
    model: modelId,
    prompt: "A sculptural editorial scene in warm studio light",
    n: 1,
    size: "1024x1024",
    response_format: "url",
  });
  const auth = contract.authentication;
  const curl = [
    `curl ${quoteShellArgument(endpointUrl)} \\`,
    `  -H "${auth.headerName}: ${auth.scheme} $${auth.environmentVariable}" \\`,
    `  -H ${quoteShellArgument(`Content-Type: ${contract.endpoint.contentType}`)} \\`,
    `  --data ${quoteShellArgument(requestBody)}`,
  ].join("\n");

  return {
    status: "available",
    curl,
    endpointUrl,
    modelId,
    requestBody,
  };
}

/**
 * 返回首页快速集成的双语三步文案。
 *
 * @param locale - 当前路由语言；只有 zh 使用中文，其余安全回退英文。
 * @returns 复用公开 API 契约的文案、复制标签与固定站内入口。
 * @sideEffects 无。
 */
export function getHomepageIntegrationContent(
  locale?: string
): HomepageIntegrationContent {
  const contract = getApiIntegrationHomepageContract(locale);
  const shared = {
    endpointPath: contract.endpoint.path,
    copyLabels: contract.copyLabels,
    links: {
      apiDocs: "/api-docs",
      apiKeys: "/dashboard/external-api",
    },
  } as const;

  if (locale === "zh") {
    return {
      ...shared,
      eyebrow: "QUICK INTEGRATION",
      title: "快速集成",
      description:
        "用现有图片生成端点完成第一次服务端请求。接口权限取决于账号、套餐与 API Key 配置。",
      steps: [
        {
          title: "创建 API Key",
          description:
            "在控制台创建 API Key，并只保存为服务端环境变量 FLUXMEDIA_API_KEY，切勿写进浏览器代码。",
        },
        {
          title: "确认当前模型",
          description:
            "从服务端使用该 API Key 请求 GET /v1/models；最终可用模型以该 API Key 的响应为准。",
        },
        {
          title: "发送图片请求",
          description: `把确认后的模型 ID 放入现有 POST ${contract.endpoint.path} 请求。`,
        },
      ],
      exampleTitle: "服务端 cURL 示例",
      modelLabel: "示例模型",
      linkLabels: {
        apiDocs: "查看 API 文档",
        apiKeys: "管理 API Key",
      },
      unavailableTitle: "示例暂不可用",
      unavailableMessages: {
        catalog_unavailable:
          "当前无法读取公开模型目录。你仍可查看 API 文档或管理 API Key。",
        no_image_model:
          "当前目录没有可用于示例的具体图像模型。请以 API Key 的 GET /v1/models 响应为准。",
        unsafe_origin:
          "站点 API origin 配置未通过安全校验，因此未生成可复制命令。",
      },
    };
  }

  return {
    ...shared,
    eyebrow: "QUICK INTEGRATION",
    title: "Quick integration",
    description:
      "Make your first server-side request with the existing image generation endpoint. Access depends on your account, plan, and API Key permissions.",
    steps: [
      {
        title: "Create an API Key",
        description:
          "Create an API Key in the console and store it only as the server environment variable FLUXMEDIA_API_KEY. Never put it in browser code.",
      },
      {
        title: "Confirm current models",
        description:
          "Call GET /v1/models from your server with that API Key. Its response is the final source of truth for available models.",
      },
      {
        title: "Send an image request",
        description: `Use a confirmed model ID with the existing POST ${contract.endpoint.path} endpoint.`,
      },
    ],
    exampleTitle: "Server-side cURL example",
    modelLabel: "Example model",
    linkLabels: {
      apiDocs: "Read API Docs",
      apiKeys: "Manage API Keys",
    },
    unavailableTitle: "Example temporarily unavailable",
    unavailableMessages: {
      catalog_unavailable:
        "The public model catalog is unavailable. You can still read the API Docs or manage API Keys.",
      no_image_model:
        "No concrete image model is available for this example. Use GET /v1/models with your API Key as the source of truth.",
      unsafe_origin:
        "The configured API origin failed validation, so no copyable command was generated.",
    },
  };
}
