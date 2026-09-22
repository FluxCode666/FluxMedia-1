/**
 * 系统文档页的双语内容与展示组件。
 *
 * 使用方：公开文档页与管理员后端帮助页。依赖共享 UI 组件渲染路由、后端能力、
 * 外部 API、审核修复与后处理说明；内容应与实际运行时契约保持同步。
 */

import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { CodeBlock } from "@repo/ui/components/code-block";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CircleHelp,
  ExternalLink,
  X,
} from "lucide-react";

import { getApiIntegrationDocs } from "./api-integration-docs-data";
import { ApiUpstreamAdapterDocs } from "./api-upstream-adapter-docs";
import {
  DOCUMENTATION_BASE_URL_PLACEHOLDER,
  replaceDocumentationBaseUrl,
} from "./documentation-base-url";
import {
  IMAGE_SIZE_DOC_TABLE_HEADERS_EN,
  IMAGE_SIZE_DOC_TABLE_HEADERS_ZH,
  IMAGE_SIZE_DOC_TABLE_NOTE_EN,
  IMAGE_SIZE_DOC_TABLE_NOTE_ZH,
  IMAGE_SIZE_DOC_TABLE_ROWS,
} from "./image-size-docs";
import { ImageSizeTable } from "./image-size-table";

/** Share current endpoint contracts with the public integration guide. */
function getSystemExternalDocs(locale: "zh" | "en") {
  const source = getApiIntegrationDocs(
    locale,
    DOCUMENTATION_BASE_URL_PLACEHOLDER
  );
  const zh = locale === "zh";
  return {
    title: zh ? "外部 API 参考" : "External API Reference",
    subtitle: source.subtitle,
    commonTitle: zh ? "通用规则" : "Common Rules",
    baseUrlTitle: source.baseUrlLabel,
    examplesTitle: source.requestExampleTitle,
    responseExampleTitle: source.responseExampleTitle,
    copyLabel: source.copyLabels.copy,
    copiedLabel: source.copyLabels.copied,
    copyFailedLabel: source.copyLabels.copyFailed,
    common: zh
      ? [
          "使用 Authorization: Bearer <API_KEY> 鉴权；仅能访问当前密钥所属用户有权使用的模型与任务。",
          "公开 API 与页面统一使用 Go 的权限、任务、积分和存储逻辑；/api/v1/* 是 /v1/* 的路径别名。",
          "图片使用 aspectRatio / aspect_ratio 和 resolution。response_format 控制 URL 或 base64，output_format 控制文件格式。",
          "视频创建返回 HTTP 202 与持久任务 ID；按返回 ID 查询结果。任务状态与产物保存在数据库中。",
          "这里与公开 API 接入页共享端点契约；供应商可用模型和能力以实时查询结果为准。",
        ]
      : [
          "Authenticate with Authorization: Bearer <API_KEY>. Model and task access is restricted to the key owner’s permissions.",
          "Public APIs and pages share Go authorization, tasks, credits, and storage. /api/v1/* aliases /v1/*.",
          "Images use aspectRatio / aspect_ratio and resolution. response_format selects URL or base64; output_format selects the file format.",
          "Video creation returns HTTP 202 and a persistent task ID. Query results using that ID; task state and outputs are stored in the database.",
          "This reference shares endpoint contracts with the public API guide. Query live model and capability endpoints for current availability.",
        ],
    officialRefsTitle: zh ? "官方协议参考" : "Official Protocol References",
    officialRefs: [
      {
        label: "Images API",
        href: "https://developers.openai.com/api/reference/resources/images",
      },
      {
        label: "Models API",
        href: "https://developers.openai.com/api/reference/resources/models/methods/list",
      },
    ],
    fieldHeaders: zh
      ? ["字段", "要求", "说明"]
      : ["Field", "Requirement", "Description"],
    responseHeaders: source.responseHeaders,
    requestTitle: source.parametersTitle,
    responseTitle: source.responsesTitle,
    notesTitle: source.notesTitle,
    customLabel: zh ? "本站扩展" : "FluxMedia Extension",
    docs: source.endpoints.map(
      (endpoint): ExternalApiDoc => ({
        title: endpoint.title,
        method: endpoint.method,
        path: endpoint.path,
        contentType: endpoint.contentType,
        description: endpoint.description,
        example: endpoint.requestExample,
        responseExample: endpoint.responseExample,
        fields: endpoint.parameters,
        responses: endpoint.responses,
        notes: endpoint.deprecationNotice
          ? [endpoint.deprecationNotice, ...endpoint.notes]
          : endpoint.notes,
      })
    ),
  };
}

const sections = {
  zh: {
    title: "系统文档",
    subtitle:
      "Next.js 提供页面、Server Actions 和请求转发；Go 后端统一处理登录权限、模型配置、图片与视频任务、积分、支付和存储。页面与外部 API 使用相同的 Go 业务服务及持久数据。",
    flow: {
      title: "请求路由图",
      note: "图片与视频请求由 Go 按 API 账号分组调度。任务、积分和产物由 Go 持久化；私有计算服务只执行脚本转换或图片处理。",
      entryTitle: "入口",
      resolverTitle: "Go 统一处理",
      groupTitle: "API 分组选择",
      backendTitle: "执行与持久化",
      entries: [
        {
          label: "页面图片创作",
          path: "Next.js → Proxy / Server Action → Go",
          kind: "image_generation / image_edit",
        },
        {
          label: "页面视频创作",
          path: "Next.js → Proxy / Server Action → Go",
          kind: "video",
        },
        {
          label: "外部文生图 API",
          path: "POST /v1/images/generations",
          kind: "image_generation",
        },
        {
          label: "外部图生图 API",
          path: "POST /v1/images/edits",
          kind: "image_edit",
        },
        {
          label: "外部视频 API",
          path: "POST /v1/videos/generations",
          kind: "video",
        },
        {
          label: "图片任务查询",
          path: "GET /v1/images/{task_id}",
          kind: "image_generation",
        },
        {
          label: "视频任务查询",
          path: "GET /v1/videos/{id}",
          kind: "video",
        },
      ],
      resolver: [
        "校验登录态或 API 密钥以及用户权限",
        "校验模型、参数和可用分组，计算费用",
        "创建持久任务、预留积分并执行内容审核",
        "Go Worker 调度供应商、保存结果并完成扣费或退款",
      ],
      groups: [
        "API 请求使用密钥绑定分组；未绑定时解析平台默认分组",
        "页面创作使用本次请求选择且用户有权使用的分组",
        "只调度启用、支持目标操作并暴露该模型的 API 账号",
        "按分组与账号配置处理优先级、并发、冷却和失败状态",
      ],
      backends: [
        {
          title: "API 账号与供应商",
          description:
            "Go 使用已配置的 Base URL、密钥、模型映射和生成/查询操作访问图片或视频供应商。",
        },
        {
          title: "Go 任务与账本",
          description:
            "PostgreSQL 保存任务、配置、使用记录、积分与订单；Redis 支持队列、并发控制和实时状态。",
        },
        {
          title: "私有计算服务",
          description:
            "上游脚本运行时执行受限的请求/响应转换；媒体处理运行时执行图像变换和模型推理。权限、调度、费用及存储仍由 Go 决定。",
        },
      ],
    },
    routeTables: {
      title: "入口到后端的映射",
      pageTitle: "页面请求",
      apiTitle: "外部 API 请求",
      headers: ["入口", "传输方式", "操作", "Go 后端行为"],
      apiHeaders: ["入口", "接口", "操作", "Go 后端行为"],
      pageRows: [
        [
          "创作页文生图与图生图",
          "请求代理 / Server Action → Go",
          "image_generation / image_edit",
          "验证用户、整理参考图、创建图片任务，并查询状态和结果。",
        ],
        [
          "创作页视频",
          "请求代理 / Server Action → Go",
          "video",
          "验证输入与报价，创建持久视频任务，查询进度与产物。",
        ],
        [
          "模型、配置及全局使用记录",
          "页面 / Server Action → Go",
          "admin / query",
          "按管理员权限读取现有配置、模型、账本和使用记录。",
        ],
      ],
      apiRows: [
        [
          "图片生成",
          "/v1/images/generations",
          "image_generation",
          "验证密钥与模型，通过 API 账号执行生成并结算实际费用。",
        ],
        [
          "图片编辑",
          "/v1/images/edits",
          "image_edit",
          "支持 JSON 图片引用或 multipart 上传，按同一 Go 流程审核、生成与存储。",
        ],
        [
          "视频生成",
          "/v1/videos/generations",
          "video",
          "创建持久任务并返回 HTTP 202；使用返回的 ID 查询终态。",
        ],
        [
          "图片任务",
          "/v1/images/{task_id}",
          "image_generation",
          "从持久记录查询本人任务，跨进程重启与多实例可查。",
        ],
        [
          "视频任务",
          "/v1/videos/{id}",
          "video",
          "查询本人持久视频任务、输入摘要、费用与结果 URL。",
        ],
        [
          "模型与视频能力",
          "/v1/models、/v1/videos/capabilities",
          "discovery",
          "返回当前密钥可用模型和视频参数约束。",
        ],
        [
          "积分额度",
          "/v1/credits",
          "credits",
          "返回账户余额与当前密钥的限额、已用及剩余额度。",
        ],
      ],
    },
    relationship: {
      title: "页面与外部 API 的关系",
      rows: [
        [
          "Next.js 页面",
          "页面组件、Server Actions、请求代理",
          "负责界面展示、表单与响应适配；业务数据从 Go 获取。",
        ],
        [
          "外部 API",
          "/v1/images/*、/v1/videos/*、/v1/models、/v1/credits",
          "使用 Bearer API 密钥；/api/v1/* 保留为相同 Go 处理逻辑的路径别名。",
        ],
        [
          "Go 业务服务",
          "身份与权限、任务、积分、支付、存储",
          "统一处理可用模型、任务归属、计费、结果落库、历史记录和错误。",
        ],
        [
          "私有运行时",
          "上游脚本转换、媒体后处理",
          "由 Go 调用，不独立提供用户业务接口或直接结算积分。",
        ],
      ],
      note: "页面和外部 API 共享 Go 后端。不同入口的身份和响应格式由各自适配层处理。",
    },
    moderation: {
      title: "内容审核与失败处理",
      description:
        "Go 在生成任务中按平台配置审核提示词与参考图，并记录实际审核结果。",
      valid: [
        "管理员统一配置审核服务与风险阈值；用户覆盖优先于全局默认值。",
        "API 密钥或请求字段不能绕过平台审核策略。",
        "审核拒绝、供应商失败和基础设施错误保留各自原因，按任务结果完成结算或退款。",
      ],
      invalid: [
        "审核被拒绝不代表已生成图片；应根据错误信息调整输入后重新提交。",
        "上游不可用或余额不足不会自动改写用户提示词。",
      ],
    },
    core: {
      title: "Go 业务后端",
      description: "用户身份和业务状态的统一入口。",
      valid: [
        "处理认证、管理员权限、模型配置、价格和分组可见性。",
        "保存图片与视频任务、历史、全局使用记录及产物归属。",
        "处理积分预留、结算、退款、充值订单与支付回调。",
      ],
      invalid: ["页面不应通过本地数据库读取绕过 Go 权限检查。"],
    },
    runtime: {
      title: "私有计算服务",
      description: "为 Go 提供有界计算能力。",
      valid: [
        "上游脚本运行时执行受限 JavaScript，转换请求和响应。",
        "媒体处理运行时执行图片变换、超分与高清修复。",
        "生成式修复需要再次调用供应商时，由 Go 调度并记录独立费用。",
      ],
      invalid: ["运行时不保存用户会话，不独立决定积分、模型权限或任务归属。"],
    },
    api: {
      title: "API 账号",
      description: "管理员配置供应商访问方式，Go 统一执行。",
      valid: [
        "按操作配置生成与查询路径、模型映射及参数转换。",
        "视频协议模式由管理员显式选择，按供应商实际能力校验输入。",
        "持久任务保存供应商任务 ID 和适配版本，恢复查询时继续使用原任务。",
      ],
      invalid: ["输出格式、质量和可用尺寸取决于供应商与已配置模型能力。"],
    },
    prompt: {
      title: "提示词与供应商参数",
      rows: [
        [
          "提示词",
          "提交用户输入，按平台审核策略检查；供应商返回的 revised_prompt 会作为结果信息保留。",
        ],
        [
          "图片尺寸",
          "使用 aspectRatio / aspect_ratio 和 resolution；具体映射由供应商尺寸配置决定。",
        ],
        [
          "模型与质量",
          "先查询 /v1/models，按模型支持范围选择 quality、背景与输出格式。",
        ],
        [
          "参考图与蒙版",
          "图生图可使用上传文件或图片引用；任务访问和存储操作按用户归属校验。",
        ],
      ],
    },
    postProcess: {
      title: "图片后处理与修复",
      rows: [
        [
          "超分与高清修复",
          "管理员启用后，Go 将需要处理的最终图交给私有媒体运行时。超分补足目标像素，高清修复进行去噪与细节恢复；不承诺固定处理时长。",
        ],
        [
          "生成式修复",
          "用户选择并且平台启用时，Go 通过可用图片供应商执行修复，额外生成调用独立计费。修复方式由平台的整图或蒙版修复配置决定。",
        ],
        [
          "费用与失败",
          "Go 记录后处理结果与生成费用。可选增强失败时尽可能保留原始结果；必需透明处理失败或任务取消仍会返回错误。",
        ],
      ],
    },
    operations: {
      title: "部署与运行检查",
      items: [
        "Next.js 与 Go 使用同一套部署配置；确认 Go 连接现有 PostgreSQL 和 Redis，避免误连空数据库。",
        "模型、支付、存储和上游配置由 Go 读取；生产环境应同时启动队列 Worker、上游脚本运行时与媒体处理运行时。",
        "容器间使用服务名访问私有运行时；浏览器仅使用公开站点地址和受权限保护的接口。",
        "遇到任务错误时，使用任务 ID 对照 Go 日志、使用记录与供应商状态；不要以重复支付或重复生成为排错手段。",
      ],
    },
    externalDocs: getSystemExternalDocs("zh"),
    imageSizeTable: {
      title: "图片尺寸表",
      description:
        "下表展示分辨率与宽高比的像素参考值；图片请求不再接受 size 参数。",
      headers: IMAGE_SIZE_DOC_TABLE_HEADERS_ZH,
      rows: IMAGE_SIZE_DOC_TABLE_ROWS,
      note: IMAGE_SIZE_DOC_TABLE_NOTE_ZH,
    },
  },
  en: {
    title: "System Docs",
    subtitle:
      "Next.js provides pages, Server Actions, and request forwarding. Go handles authentication, model configuration, image and video tasks, credits, payments, and storage. Pages and external APIs share the same Go services and persistent data.",
    flow: {
      title: "Request Routing",
      note: "Go routes image and video requests through API account groups and persists tasks, credits, and outputs. Private runtimes perform script transformations or image processing.",
      entryTitle: "Entry Points",
      resolverTitle: "Go Services",
      groupTitle: "API Group Selection",
      backendTitle: "Execution and Persistence",
      entries: [
        {
          label: "Image workspace",
          path: "Next.js → Proxy / Server Action → Go",
          kind: "image_generation / image_edit",
        },
        {
          label: "Video workspace",
          path: "Next.js → Proxy / Server Action → Go",
          kind: "video",
        },
        {
          label: "External image generation",
          path: "POST /v1/images/generations",
          kind: "image_generation",
        },
        {
          label: "External image editing",
          path: "POST /v1/images/edits",
          kind: "image_edit",
        },
        {
          label: "External video generation",
          path: "POST /v1/videos/generations",
          kind: "video",
        },
        {
          label: "Image task lookup",
          path: "GET /v1/images/{task_id}",
          kind: "image_generation",
        },
        {
          label: "Video task lookup",
          path: "GET /v1/videos/{id}",
          kind: "video",
        },
      ],
      resolver: [
        "Validate the session or API key and user permissions",
        "Validate models, parameters, and available groups; calculate charges",
        "Persist the task, reserve credits, and apply content moderation",
        "Go workers call providers, save outputs, and settle charges or refunds",
      ],
      groups: [
        "API requests use the key’s assigned group, falling back to the platform default when unassigned",
        "Workspace requests use a selected group the user is authorized to access",
        "Only enabled API accounts exposing the model and supporting the operation can be selected",
        "Group and account settings govern priority, concurrency, cooldowns, and failure handling",
      ],
      backends: [
        {
          title: "API Accounts and Providers",
          description:
            "Go calls image and video providers using configured base URLs, credentials, model mappings, and generation/query operations.",
        },
        {
          title: "Go Tasks and Ledger",
          description:
            "PostgreSQL stores tasks, configuration, usage, credits, and orders. Redis supports queues, concurrency control, and live status.",
        },
        {
          title: "Private Compute Runtimes",
          description:
            "The upstream script runtime transforms bounded requests and responses; the media runtime performs image operations and inference. Go owns permissions, scheduling, billing, and storage.",
        },
      ],
    },
    routeTables: {
      title: "Entry Point Mapping",
      pageTitle: "Workspace Requests",
      apiTitle: "External API Requests",
      headers: ["Entry", "Transport", "Operation", "Go behavior"],
      apiHeaders: ["Entry", "Endpoint", "Operation", "Go behavior"],
      pageRows: [
        [
          "Image generation and editing",
          "Proxy / Server Action → Go",
          "image_generation / image_edit",
          "Validate the user and references, create image tasks, and read status and results.",
        ],
        [
          "Video creation",
          "Proxy / Server Action → Go",
          "video",
          "Validate inputs and quotes, create persistent video tasks, and retrieve progress and outputs.",
        ],
        [
          "Models, settings, and global usage",
          "Page / Server Action → Go",
          "admin / query",
          "Read existing configuration, models, ledgers, and usage under administrator permissions.",
        ],
      ],
      apiRows: [
        [
          "Image generation",
          "/v1/images/generations",
          "image_generation",
          "Validate the key and model, execute through API accounts, and settle actual charges.",
        ],
        [
          "Image editing",
          "/v1/images/edits",
          "image_edit",
          "Accept JSON image references or multipart uploads; apply Go moderation, generation, and storage.",
        ],
        [
          "Video creation",
          "/v1/videos/generations",
          "video",
          "Persist a task and return HTTP 202; use its ID to retrieve the terminal result.",
        ],
        [
          "Image task",
          "/v1/images/{task_id}",
          "image_generation",
          "Retrieve an owned persistent task across restarts and instances.",
        ],
        [
          "Video task",
          "/v1/videos/{id}",
          "video",
          "Read an owned persistent task, input summary, billing, and output URLs.",
        ],
        [
          "Models and video capabilities",
          "/v1/models, /v1/videos/capabilities",
          "discovery",
          "Return models available to the current key and supported video parameters.",
        ],
        [
          "Credits",
          "/v1/credits",
          "credits",
          "Return the account balance and the current key’s limit, usage, and remaining allowance.",
        ],
      ],
    },
    relationship: {
      title: "Pages and External APIs",
      rows: [
        [
          "Next.js pages",
          "Components, Server Actions, and request proxies",
          "Render interfaces and adapt forms and responses; obtain business data from Go.",
        ],
        [
          "External API",
          "/v1/images/*, /v1/videos/*, /v1/models, /v1/credits",
          "Authenticate with Bearer API keys. /api/v1/* aliases use the same Go handlers.",
        ],
        [
          "Go business services",
          "Identity, permissions, tasks, credits, payments, and storage",
          "Own model availability, task access, billing, output persistence, history, and errors.",
        ],
        [
          "Private runtimes",
          "Upstream script conversion and media processing",
          "Called by Go; they do not expose independent user business endpoints or settle credits.",
        ],
      ],
      note: "Pages and external APIs share the Go backend. Each entry adapts its identity and response format.",
    },
    moderation: {
      title: "Content Moderation and Failures",
      description:
        "Go checks prompts and reference images using platform moderation settings and records the actual result on the task.",
      valid: [
        "Administrators configure moderation providers and thresholds; a user override takes precedence over the global default.",
        "API keys and request fields cannot bypass platform moderation policy.",
        "Moderation blocks, provider failures, and infrastructure errors retain their own reasons; charges or refunds follow the task result.",
      ],
      invalid: [
        "A moderation block does not mean an image was generated. Adjust the input according to the error before resubmitting.",
        "Provider outages and insufficient credits do not automatically rewrite the prompt.",
      ],
    },
    core: {
      title: "Go Business Backend",
      description: "The shared authority for user identity and business state.",
      valid: [
        "Handles authentication, administrator permissions, model configuration, pricing, and group visibility.",
        "Persists image and video tasks, history, global usage, and output ownership.",
        "Handles credit reservations, settlement, refunds, checkout orders, and payment callbacks.",
      ],
      invalid: [
        "Pages should not bypass Go authorization through local database reads.",
      ],
    },
    runtime: {
      title: "Private Compute Runtimes",
      description: "Bounded computation called by Go.",
      valid: [
        "The upstream runtime executes restricted JavaScript for request and response conversion.",
        "The media runtime performs image transformations, super-resolution, and restoration.",
        "Go schedules extra provider calls for generative repair and records their separate charges.",
      ],
      invalid: [
        "Runtimes do not own user sessions, billing decisions, model permissions, or task access.",
      ],
    },
    api: {
      title: "API Accounts",
      description:
        "Administrators configure provider access; Go executes the requests.",
      valid: [
        "Configure generation and query paths, model mappings, and parameter transformations per operation.",
        "Administrators explicitly select the video protocol; inputs are checked against provider capabilities.",
        "Persistent tasks retain provider task IDs and adapter versions so recovery continues the original task.",
      ],
      invalid: [
        "Output format, quality, and dimensions depend on the provider and configured model capabilities.",
      ],
    },
    prompt: {
      title: "Prompts and Provider Parameters",
      rows: [
        [
          "Prompt",
          "Submit the user’s input and apply platform moderation. Preserve an upstream revised_prompt as result information when supplied.",
        ],
        [
          "Image dimensions",
          "Use aspectRatio / aspect_ratio and resolution. Provider size configuration determines the upstream mapping.",
        ],
        [
          "Model and quality",
          "Query /v1/models first, then choose quality, background, and output format supported by the model.",
        ],
        [
          "References and masks",
          "Image edits accept uploaded files or image references. Task and storage access are checked against the owner.",
        ],
      ],
    },
    postProcess: {
      title: "Image Processing and Repair",
      rows: [
        [
          "Super-resolution and restoration",
          "When enabled, Go sends final images to the private media runtime. Super-resolution fills the requested pixel size; restoration reduces noise and repairs detail. Processing time depends on the workload.",
        ],
        [
          "Generative repair",
          "When requested and enabled, Go invokes an available image provider for repair and bills the additional generation separately. Platform settings select whole-image or mask repair.",
        ],
        [
          "Charges and failures",
          "Go records processing results and generation charges. Optional enhancement failures preserve the original output where possible; required transparency processing failures and task cancellation still return errors.",
        ],
      ],
    },
    operations: {
      title: "Deployment and Runtime Checks",
      items: [
        "Use consistent deployment configuration for Next.js and Go. Verify that Go connects to the existing PostgreSQL and Redis rather than an empty database.",
        "Go reads model, payment, storage, and provider configuration. Production also runs queue workers, the upstream script runtime, and the media processing runtime.",
        "Containers reach private runtimes through service names; browsers use the public site address and authorized endpoints.",
        "Investigate task failures by correlating the task ID with Go logs, usage records, and provider status. Avoid duplicate payments or generations while troubleshooting.",
      ],
    },
    externalDocs: getSystemExternalDocs("en"),
    imageSizeTable: {
      title: "Image Size Table",
      description:
        "The table lists pixel references for the creation workspace's resolution and aspect-ratio choices; image requests do not accept a size parameter.",
      headers: IMAGE_SIZE_DOC_TABLE_HEADERS_EN,
      rows: IMAGE_SIZE_DOC_TABLE_ROWS,
      note: IMAGE_SIZE_DOC_TABLE_NOTE_EN,
    },
  },
} as const;

type TableRow = readonly [string, string, string, string];
type RelationshipRow = readonly [string, string, string];
type ExternalApiField = {
  name: string;
  requirement?: string;
  description: string;
  custom?: boolean;
};
type ExternalApiResponseField = {
  name: string;
  description: string;
  custom?: boolean;
};
type ExternalApiDoc = {
  title: string;
  method: string;
  path: string;
  contentType: string;
  description: string;
  example: string;
  responseExample: string;
  fields: readonly ExternalApiField[];
  responses: readonly ExternalApiResponseField[];
  notes: readonly string[];
};

/**
 * 为单个系统文档端点创建绑定当前请求域名的副本。
 *
 * @param doc - 含静态 Base URL 占位符的端点模板。
 * @param baseUrl - 当前请求对应且不带尾斜杠的 HTTP(S) origin。
 * @returns 仅替换请求与响应示例的新端点对象。
 * @sideEffects 无；不修改模块级 sections，避免并发请求串用域名。
 */
function bindSystemDocsEndpointBaseUrl(
  doc: ExternalApiDoc,
  baseUrl: string
): ExternalApiDoc {
  return {
    ...doc,
    example: replaceDocumentationBaseUrl(doc.example, baseUrl),
    responseExample: replaceDocumentationBaseUrl(doc.responseExample, baseUrl),
  };
}

/**
 * 渲染支持项或限制项列表。
 *
 * @param items 要展示的说明文本；支持 `**文本**` 强调语法。
 * @param type 列表语义，决定勾选或叉号图标；无外部副作用。
 * @returns 带语义图标的列表；空数组时返回空列表容器。
 */
function ListBlock({
  items,
  type,
}: {
  items: readonly string[];
  type: "valid" | "invalid";
}) {
  const Icon = type === "valid" ? Check : X;
  // 单色体系:支持项用前景色勾,不支持项用 muted 叉,靠图标形状区分语义
  const color = type === "valid" ? "text-foreground" : "text-muted-foreground";
  return (
    <ul className="space-y-2 text-sm text-muted-foreground">
      {items.map((item) => (
        <li className="flex gap-2" key={item}>
          <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${color}`} />
          <span>{renderEmphasis(item)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * 将说明文本中的 `**文本**` 片段转换为强调节点。
 *
 * @param text 未信任为富文本的普通字符串。
 * @returns React 可渲染片段；不匹配或未闭合标记时保持原文。
 */
function renderEmphasis(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  let emphasisIndex = 0;
  return parts.map((part) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      emphasisIndex += 1;
      return (
        <strong
          className="font-semibold text-foreground"
          key={`emphasis-${emphasisIndex}-${part}`}
        >
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

/**
 * 渲染入口、统一处理、分组选择和后端落点组成的路由图。
 *
 * @param flow 当前语言的路由图数据。
 * @returns 响应式路由卡片；只读渲染且无外部副作用。
 */
function RouteDiagram({
  flow,
}: {
  flow: typeof sections.zh.flow | typeof sections.en.flow;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {flow.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {flow.note}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 lg:grid-cols-[1.2fr_auto_1fr_auto_1fr_auto_1.15fr] lg:items-stretch">
          <RouteColumn title={flow.entryTitle}>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              {flow.entries.map((entry) => (
                <div
                  className="rounded-md border bg-background p-3"
                  key={`${entry.path}:${entry.kind}:${entry.label}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{entry.label}</span>
                    <Badge
                      variant="secondary"
                      className="rounded-sm font-mono text-[10px]"
                    >
                      {entry.kind}
                    </Badge>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {entry.path}
                  </div>
                </div>
              ))}
            </div>
          </RouteColumn>

          <RouteArrow />

          <RouteColumn title={flow.resolverTitle}>
            <NumberedItems items={flow.resolver} />
          </RouteColumn>

          <RouteArrow />

          <RouteColumn title={flow.groupTitle}>
            <NumberedItems items={flow.groups} />
          </RouteColumn>

          <RouteArrow />

          <RouteColumn title={flow.backendTitle}>
            <div className="space-y-2">
              {flow.backends.map((backend) => (
                <div
                  className="rounded-md border bg-background p-3"
                  key={backend.title}
                >
                  <div className="text-sm font-medium">{backend.title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {backend.description}
                  </p>
                </div>
              ))}
            </div>
          </RouteColumn>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 渲染路由图中的单列容器。
 *
 * @param title 列标题。
 * @param children 列内内容。
 * @returns 统一样式的列容器。
 */
function RouteColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      {/* 列标签 - v2 小标签规范:11px 大写宽字距,font-medium 代替粗体 */}
      <div className="mb-3 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * 渲染路由图列之间的响应式方向箭头。
 *
 * @returns 窄屏向下、宽屏向右的箭头；无参数与副作用。
 */
function RouteArrow() {
  return (
    <div className="flex items-center justify-center text-muted-foreground">
      <ArrowDown className="h-5 w-5 lg:hidden" />
      <ArrowRight className="hidden h-5 w-5 lg:block" />
    </div>
  );
}

/**
 * 渲染带顺序编号的说明列表。
 *
 * @param items 按展示顺序排列的文本。
 * @returns 编号列表；空数组时返回空列表容器。
 */
function NumberedItems({ items }: { items: readonly string[] }) {
  return (
    <ol className="space-y-2 text-sm text-muted-foreground">
      {items.map((item, index) => (
        <li className="flex gap-2" key={item}>
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background text-[11px] font-medium text-foreground">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 渲染入口与后端行为的四列表格。
 *
 * @param title 表格标题。
 * @param headers 四个列标题。
 * @param rows 入口、端点、调度类型与行为数据。
 * @returns 响应式表格；输入列数由只读元组类型约束。
 */
function RouteTable({
  title,
  headers,
  rows,
}: {
  title: string;
  headers: readonly string[];
  rows: readonly TableRow[];
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="overflow-hidden rounded-md border">
        <div className="hidden grid-cols-[1fr_1.15fr_0.8fr_1.8fr] border-b bg-muted/40 text-xs font-medium text-muted-foreground md:grid">
          {headers.map((header) => (
            <div className="px-3 py-2" key={header}>
              {header}
            </div>
          ))}
        </div>
        {rows.map(([entry, endpoint, kind, behavior]) => (
          <div
            className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[1fr_1.15fr_0.8fr_1.8fr]"
            key={`${entry}-${endpoint}`}
          >
            <div className="font-medium text-foreground">{entry}</div>
            <div className="font-mono text-xs text-muted-foreground">
              {endpoint}
            </div>
            <div>
              <Badge
                variant="outline"
                className="rounded-sm font-mono text-[10px]"
              >
                {kind}
              </Badge>
            </div>
            <div className="text-muted-foreground">{behavior}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 渲染页面入口、外部入口与共同核心之间的关系表。
 *
 * @param relationship 当前语言的关系说明数据。
 * @returns 关系卡片；只读渲染且无外部副作用。
 */
function RelationshipTable({
  relationship,
}: {
  relationship:
    | typeof sections.zh.relationship
    | typeof sections.en.relationship;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {relationship.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {relationship.note}
        </p>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-md border">
          {relationship.rows.map(
            ([name, endpoints, description]: RelationshipRow) => (
              <div
                className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[160px_minmax(0,1fr)_minmax(0,1.7fr)]"
                key={name}
              >
                <div className="font-medium text-foreground">{name}</div>
                <div className="min-w-0 whitespace-normal break-words font-mono text-xs leading-relaxed text-muted-foreground">
                  {endpoints}
                </div>
                <div className="min-w-0 break-words text-muted-foreground">
                  {description}
                </div>
              </div>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 渲染外部 API 总览、参考链接与所有端点文档。
 *
 * @param docs 当前语言的外部 API 文档数据。
 * @param baseUrl 当前请求对应的 HTTP(S) origin。
 * @returns 外部 API 文档卡片；复制行为委托给共享 CodeBlock。
 */
function ExternalApiDocs({
  baseUrl,
  docs,
}: {
  baseUrl: string;
  docs: typeof sections.zh.externalDocs | typeof sections.en.externalDocs;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {docs.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {docs.subtitle}
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-md border p-4">
            <div className="rounded-md bg-muted/50 p-3">
              <div className="text-xs font-medium text-muted-foreground">
                {docs.baseUrlTitle}
              </div>
              <div className="mt-1 font-mono text-sm text-foreground">
                {baseUrl}
              </div>
            </div>
            <h3 className="mt-4 text-sm font-medium">{docs.commonTitle}</h3>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {docs.common.map((item) => {
                const emphasize =
                  item.startsWith("异步任务（async）") ||
                  item.startsWith("Async tasks (async)");
                return (
                  <li className="flex gap-2" key={item}>
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                    <span
                      className={
                        emphasize ? "font-semibold text-foreground" : undefined
                      }
                    >
                      {item}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-medium">{docs.officialRefsTitle}</h3>
            <div className="mt-3 space-y-2">
              {docs.officialRefs.map((ref) => (
                <a
                  className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm text-foreground transition-colors duration-150 hover:bg-muted"
                  href={ref.href}
                  key={ref.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span>{ref.label}</span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          {docs.docs.map((doc) => (
            <ExternalEndpointDoc
              copiedLabel={docs.copiedLabel}
              copyFailedLabel={docs.copyFailedLabel}
              copyLabel={docs.copyLabel}
              customLabel={docs.customLabel}
              doc={bindSystemDocsEndpointBaseUrl(doc, baseUrl)}
              fieldHeaders={docs.fieldHeaders}
              key={doc.path}
              notesTitle={docs.notesTitle}
              examplesTitle={docs.examplesTitle}
              responseExampleTitle={docs.responseExampleTitle}
              requestTitle={docs.requestTitle}
              responseHeaders={docs.responseHeaders}
              responseTitle={docs.responseTitle}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 渲染本站扩展字段标记。
 *
 * @param label 当前语言的标记文案。
 * @returns 次要样式徽标。
 */
function CustomMarker({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="rounded-sm text-[10px]">
      {label}
    </Badge>
  );
}

/**
 * 渲染请求或响应字段名及其扩展标记。
 *
 * @param field 字段定义；含多个别名时按 ` / ` 分行。
 * @param customLabel 本站扩展字段的本地化标签。
 * @returns 字段名单元；路径与枚举中的普通斜杠保持不变。
 */
function FieldName({
  field,
  customLabel,
}: {
  field: ExternalApiField | ExternalApiResponseField;
  customLabel: string;
}) {
  return (
    <div className="space-y-1">
      <div
        className={`font-mono text-xs leading-relaxed ${
          field.custom
            ? "font-semibold text-foreground"
            : "text-muted-foreground"
        }`}
      >
        {/* 参数名常把多个等价别名用 " / " 串联（如 "aspectRatio / aspect_ratio"）。
            内联渲染时 " / " 易被误读为"或"，故按 " / "（前后带空格）拆分，每个名字单独成行。
            仅含空格的 " / " 触发拆分；路径/枚举里无空格的斜杠（如 "/v1/images/generations"、
            "low/medium/high"）保持单行不受影响。 */}
        {field.name.split(" / ").map((part) => (
          <div key={part}>{part}</div>
        ))}
      </div>
      {field.custom && <CustomMarker label={customLabel} />}
    </div>
  );
}

/**
 * 渲染单个外部 API 端点的示例、字段、响应与注意事项。
 *
 * @param doc 端点契约与示例。
 * @param fieldHeaders 请求字段表头。
 * @param responseHeaders 响应字段表头。
 * @param requestTitle 请求字段标题。
 * @param responseTitle 响应字段标题。
 * @param notesTitle 注意事项标题。
 * @param examplesTitle 请求示例标题。
 * @param responseExampleTitle 响应示例标题。
 * @param copyLabel 复制按钮文案。
 * @param copiedLabel 复制成功文案。
 * @param copyFailedLabel 复制失败文案。
 * @param customLabel 本站扩展字段标签。
 * @returns 完整端点章节；复制失败由 CodeBlock 以本地化文案呈现。
 */
function ExternalEndpointDoc({
  doc,
  fieldHeaders,
  responseHeaders,
  requestTitle,
  responseTitle,
  notesTitle,
  examplesTitle,
  responseExampleTitle,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  customLabel,
}: {
  doc: ExternalApiDoc;
  fieldHeaders: readonly string[];
  responseHeaders: readonly string[];
  requestTitle: string;
  responseTitle: string;
  notesTitle: string;
  examplesTitle: string;
  responseExampleTitle: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  customLabel: string;
}) {
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="space-y-3 border-b bg-muted/20 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-sm font-mono">
            {doc.method}
          </Badge>
          <span className="font-mono text-sm font-medium">{doc.path}</span>
          <Badge
            variant="secondary"
            className="rounded-sm font-mono text-[10px]"
          >
            {doc.contentType}
          </Badge>
        </div>
        <div>
          <h3 className="text-base font-medium">{doc.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {doc.description}
          </p>
        </div>
      </div>

      <div className="space-y-5 p-4">
        <div>
          <h4 className="text-sm font-medium">{examplesTitle}</h4>
          <CodeBlock
            className="mt-2"
            code={doc.example}
            labels={{
              copy: copyLabel,
              copied: copiedLabel,
              copyFailed: copyFailedLabel,
            }}
            language="bash"
          />
        </div>
        <div>
          <h4 className="text-sm font-medium">{responseExampleTitle}</h4>
          <CodeBlock
            className="mt-2"
            code={doc.responseExample}
            labels={{
              copy: copyLabel,
              copied: copiedLabel,
              copyFailed: copyFailedLabel,
            }}
            language="text"
          />
        </div>
        <EndpointFieldTable
          customLabel={customLabel}
          fields={doc.fields}
          headers={fieldHeaders}
          title={requestTitle}
        />
        <EndpointResponseTable
          customLabel={customLabel}
          fields={doc.responses}
          headers={responseHeaders}
          title={responseTitle}
        />
        <div>
          <h4 className="text-sm font-medium">{notesTitle}</h4>
          <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
            {doc.notes.map((note) => (
              <li className="flex gap-2" key={note}>
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/**
 * 渲染外部 API 请求字段表。
 *
 * @param title 表格标题。
 * @param headers 三个列标题。
 * @param fields 请求字段定义。
 * @param customLabel 本站扩展字段标签。
 * @returns 响应式请求字段表；缺少 requirement 时显示短横线。
 */
function EndpointFieldTable({
  title,
  headers,
  fields,
  customLabel,
}: {
  title: string;
  headers: readonly string[];
  fields: readonly ExternalApiField[];
  customLabel: string;
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="mt-2 overflow-hidden rounded-md border">
        <div className="hidden grid-cols-[1.1fr_0.75fr_1.8fr] border-b bg-muted/40 text-xs font-medium text-muted-foreground md:grid">
          {headers.map((header) => (
            <div className="px-3 py-2" key={header}>
              {header}
            </div>
          ))}
        </div>
        {fields.map((field) => (
          <div
            className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[1.1fr_0.75fr_1.8fr]"
            key={field.name}
          >
            <FieldName customLabel={customLabel} field={field} />
            <div className="text-muted-foreground">
              {field.requirement || "-"}
            </div>
            <div className="text-muted-foreground">{field.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 渲染外部 API 响应字段表。
 *
 * @param title 表格标题。
 * @param headers 两个列标题。
 * @param fields 响应字段定义。
 * @param customLabel 本站扩展字段标签。
 * @returns 响应式响应字段表。
 */
function EndpointResponseTable({
  title,
  headers,
  fields,
  customLabel,
}: {
  title: string;
  headers: readonly string[];
  fields: readonly ExternalApiResponseField[];
  customLabel: string;
}) {
  return (
    <div>
      <h4 className="text-sm font-medium">{title}</h4>
      <div className="mt-2 overflow-hidden rounded-md border">
        <div className="hidden grid-cols-[1.2fr_2fr] border-b bg-muted/40 text-xs font-medium text-muted-foreground md:grid">
          {headers.map((header) => (
            <div className="px-3 py-2" key={header}>
              {header}
            </div>
          ))}
        </div>
        {fields.map((field) => (
          <div
            className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[1.2fr_2fr]"
            key={field.name}
          >
            <FieldName customLabel={customLabel} field={field} />
            <div className="text-muted-foreground">{field.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 获取系统文档页的本地化元数据。
 *
 * @param locale 路由语言；仅 `zh` 使用中文，其余值回退英文。
 * @returns 页面标题与描述；无外部副作用。
 */
export function getSystemDocsMetadata(locale = "en") {
  const content = locale === "zh" ? sections.zh : sections.en;

  return {
    title: content.title,
    description: content.subtitle,
  };
}

/**
 * 读取系统文档中的外部视频端点契约。
 *
 * @param locale 路由语言；仅 `zh` 使用中文，其余值回退英文。
 * @param baseUrl 可选的当前请求 origin；传入时替换所有请求与响应示例。
 * @returns 创建与查询两个视频端点的本地化文档数据；不修改共享静态内容。
 * @sideEffects 无。
 * @failure 端点缺失时返回不足两项，由契约测试和渲染调用方显式发现。
 */
export function getSystemDocsVideoEndpoints(locale = "en", baseUrl?: string) {
  const content = locale === "zh" ? sections.zh : sections.en;
  const endpoints = content.externalDocs.docs.filter(
    (endpoint) =>
      endpoint.path === "/v1/videos/generations" ||
      endpoint.path === "/v1/videos/{id}"
  );
  return baseUrl
    ? endpoints.map((endpoint) =>
        bindSystemDocsEndpointBaseUrl(endpoint, baseUrl)
      )
    : endpoints;
}

/**
 * 渲染完整系统文档页。
 *
 * @param baseUrl 当前请求对应的 HTTP(S) origin。
 * @param locale 路由语言；仅 `zh` 使用中文，其余值回退英文。
 * @param className 页面根容器样式。
 * @returns 双语系统文档内容；静态数据异常会在渲染阶段显式暴露。
 */
export function SystemDocsContent({
  baseUrl,
  locale = "en",
  className = "container mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-6",
}: {
  baseUrl: string;
  locale?: string;
  className?: string;
}) {
  const content = locale === "zh" ? sections.zh : sections.en;

  // 章节锚点目录:文案全部沿用各章节卡片既有标题,不新增文案。
  // 「后端落点」复用路由图列标题指代下方三张后端能力卡。
  const tocItems = [
    { id: "flow", label: content.flow.title },
    { id: "relationship", label: content.relationship.title },
    { id: "moderation", label: content.moderation.title },
    { id: "external-api", label: content.externalDocs.title },
    { id: "image-size-table", label: content.imageSizeTable.title },
    { id: "route-tables", label: content.routeTables.title },
    { id: "backends", label: content.flow.backendTitle },
    {
      id: "api-upstream-adapter",
      label: locale === "zh" ? "API 账号上游适配" : "API upstream adapters",
    },
    { id: "prompt", label: content.prompt.title },
    { id: "post-process", label: content.postProcess.title },
    { id: "operations", label: content.operations.title },
  ];

  return (
    <div className={className}>
      <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <div className="flex items-center gap-2">
          <CircleHelp className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-serif text-2xl font-medium tracking-tight md:text-3xl">
            {content.title}
          </h1>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {content.subtitle}
        </p>
      </div>

      {/* 粘性锚点目录:停驻在顶栏下方(top-16),半透明底 + backdrop-blur;
          序号用等宽字建立次序层次,窄屏横向滚动。控制台入口的祖先容器
          带 overflow,粘性在该处自动退化为静态目录,不影响锚点跳转。 */}
      <nav
        aria-label={content.title}
        className="sticky top-16 z-20 rounded-lg border border-border/60 bg-background/95 shadow-whisper backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <div className="flex items-center gap-1 overflow-x-auto px-2 py-2">
          {tocItems.map((item, index) => (
            <a
              className="flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
              href={`#${item.id}`}
              key={item.id}
            >
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {String(index + 1).padStart(2, "0")}
              </span>
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      {/* 各章节包一层锚点容器:scroll-mt 预留顶栏 + 粘性目录的停驻高度 */}
      <div className="scroll-mt-32" id="flow">
        <RouteDiagram flow={content.flow} />
      </div>

      <div className="scroll-mt-32" id="relationship">
        <RelationshipTable relationship={content.relationship} />
      </div>

      <Card className="scroll-mt-32 rounded-lg" id="moderation">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.moderation.title}
          </CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {content.moderation.description}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border bg-muted/20 p-4">
            <ListBlock items={content.moderation.valid} type="valid" />
          </div>
          <div className="rounded-md border bg-muted/20 p-4">
            <ListBlock items={content.moderation.invalid} type="invalid" />
          </div>
        </CardContent>
      </Card>

      <div className="scroll-mt-32" id="external-api">
        <ExternalApiDocs baseUrl={baseUrl} docs={content.externalDocs} />
      </div>

      <div className="scroll-mt-32" id="image-size-table">
        <ImageSizeTable table={content.imageSizeTable} />
      </div>

      <Card className="scroll-mt-32 rounded-lg" id="route-tables">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.routeTables.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <RouteTable
            title={content.routeTables.pageTitle}
            headers={content.routeTables.headers}
            rows={content.routeTables.pageRows}
          />
          <RouteTable
            title={content.routeTables.apiTitle}
            headers={content.routeTables.apiHeaders}
            rows={content.routeTables.apiRows}
          />
        </CardContent>
      </Card>

      <div className="scroll-mt-32 grid gap-4 lg:grid-cols-3" id="backends">
        {[content.core, content.runtime, content.api].map((section) => (
          <Card className="rounded-lg" key={section.title}>
            <CardHeader>
              <CardTitle className="font-serif text-lg tracking-tight">
                {section.title}
              </CardTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <ListBlock items={section.valid} type="valid" />
              <ListBlock items={section.invalid} type="invalid" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="scroll-mt-32" id="api-upstream-adapter">
        <ApiUpstreamAdapterDocs locale={locale} />
      </div>

      <Card className="scroll-mt-32 rounded-lg" id="prompt">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.prompt.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            {content.prompt.rows.map(([label, description]) => (
              <div
                className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[180px_1fr]"
                key={label}
              >
                <div className="font-medium text-foreground">{label}</div>
                <div className="text-muted-foreground">{description}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="scroll-mt-32 rounded-lg" id="post-process">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.postProcess.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-md border">
            {content.postProcess.rows.map(([label, description]) => (
              <div
                className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[180px_1fr]"
                key={label}
              >
                <div className="font-medium text-foreground">{label}</div>
                <div className="text-muted-foreground">{description}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="scroll-mt-32 rounded-lg" id="operations">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.operations.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {content.operations.items.map((item) => (
              <li className="flex gap-2" key={item}>
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
