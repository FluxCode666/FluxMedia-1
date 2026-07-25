/**
 * 当前媒体系统文档。
 *
 * 使用方：公开文档页与管理员后端帮助页。职责是只描述现行图片、视频、统一号池、
 * 计费与恢复链路；内容必须与实际路由和运行时契约同步。
 */

import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { ArrowRight, CircleHelp } from "lucide-react";

type DocsContent = {
  title: string;
  subtitle: string;
  sections: Array<{
    id: string;
    title: string;
    description: string;
    items: string[];
  }>;
  routes: {
    title: string;
    description: string;
    headers: [string, string, string];
    rows: Array<[string, string, string]>;
  };
};

const contentByLocale: Record<"zh" | "en", DocsContent> = {
  zh: {
    title: "FluxMedia 系统文档",
    subtitle:
      "FluxMedia 只提供图片与视频生成能力。页面和外部 API 都是统一接口层的薄适配器，共用审核、调度、积分、存储与任务状态。",
    sections: [
      {
        id: "pipeline",
        title: "统一媒体链路",
        description:
          "所有图片入口最终汇入 runImageGenerationForUser；视频由持久状态机提交并由后台 worker 恢复。",
        items: [
          "传输层校验请求并构造用户或 API Key Principal。",
          "UOL 网关统一执行权限、套餐能力和资源归属校验。",
          "图片生成、图片编辑与蒙版编辑共用单一图片管线。",
          "视频提交成功后固定原成员与原 token，轮询和下载不得跨成员重投。",
          "最终产物写入本站存储，再返回受控签名 URL。",
        ],
      },
      {
        id: "pool",
        title: "统一媒体号池",
        description:
          "顶层成员只有 API 与 Adobe 两类；Adobe 配置再区分 gateway 与 direct。",
        items: [
          "同一号池页面管理分组、成员、模型能力、优先级、并发和健康状态。",
          "模型 ID 是显式能力键，调度器不从模型名称前缀推断成员类型。",
          "一次请求在指定分组的全部合格成员中选择候选，图片和视频都不使用粘性会话。",
          "Adobe direct 成员可维护多个账号与 token，但它们始终归属于同一个统一成员。",
        ],
      },
      {
        id: "scheduling",
        title: "动态调度策略",
        description:
          "系统配置中的 IMAGE_BACKEND_SCHEDULING_STRATEGY 可动态切换全局策略。",
        items: [
          "priority：按成员优先级选择，数值越小越优先。",
          "least_acquired：优先选择累计获租次数最少的成员。",
          "least_load：优先选择当前租约负载率最低的成员。",
          "无候选、容量拒绝、获租、切换和终态失败都会写入不含业务载荷的调度指标。",
        ],
      },
      {
        id: "video",
        title: "视频恢复与幂等",
        description:
          "视频任务以 Principal 作用域内的 clientRequestId 幂等，并通过数据库 claim 与状态版本跨进程恢复。",
        items: [
          "同一用户下不同 API Key 的相同请求键互不命中。",
          "提交前明确失败可以排除当前成员并重选。",
          "取得 pollUrl 后只使用持久化的原成员和原 token。",
          "提交结果不确定时保留诊断状态，不自动重投或退款。",
          "对象存储键、扣费键和退款键稳定，重复 worker 只能收敛到一个终态。",
        ],
      },
      {
        id: "security",
        title: "安全边界",
        description:
          "所有外部输入、资源访问和上游地址都采用 fail-closed 校验。",
        items: [
          "Cookie 写路由要求受信 Origin，Bearer 路由使用 API Key Principal。",
          "资源查询同时校验 userId 与 apiKeyId，避免同用户多密钥互相读取。",
          "Adobe direct 请求经专用代理，只允许代码内精确 Adobe HTTPS 主机。",
          "代理请求和健康检查共用恒定时间密钥鉴权，日志不记录凭据或媒体载荷。",
          "积分账本和任务状态分别通过数据库唯一约束与比较交换保护并发。",
        ],
      },
    ],
    routes: {
      title: "现行路由",
      description:
        "/v1 与 /api/v1 是同一 handler 的别名；外部视频生成必须提供 clientRequestId。",
      headers: ["入口", "方法与路径", "用途"],
      rows: [
        ["页面图片", "POST /api/images/generate", "图片生成"],
        ["页面编辑", "POST /api/images/edit", "图片编辑与蒙版编辑"],
        ["页面状态", "GET /api/images/status/{id}", "读取本人图片任务"],
        ["页面视频", "POST /api/videos/generate", "创建幂等视频任务"],
        ["页面视频状态", "GET /api/videos/{taskId}", "读取本人视频任务"],
        ["外部图片", "POST /v1/images/generations", "OpenAI 风格图片生成"],
        ["外部编辑", "POST /v1/images/edits", "OpenAI 风格图片编辑"],
        [
          "外部图片状态",
          "GET /v1/images/{taskId}",
          "读取 API Key 所属图片任务",
        ],
        ["外部视频", "POST /v1/videos/generations", "创建持久视频任务"],
        [
          "外部视频状态",
          "GET /v1/videos/{taskId}",
          "读取 API Key 所属视频任务",
        ],
        ["模型", "GET /v1/models", "列出可用媒体模型"],
        ["积分", "GET /v1/credits", "读取当前 API Key 用户积分"],
      ],
    },
  },
  en: {
    title: "FluxMedia System Guide",
    subtitle:
      "FluxMedia provides image and video generation only. Page and external API routes are thin adapters over one operation layer and share moderation, scheduling, credits, storage, and task state.",
    sections: [
      {
        id: "pipeline",
        title: "Unified media pipeline",
        description:
          "Every image route converges on runImageGenerationForUser. Video submissions are resumed by a persistent state machine and background worker.",
        items: [
          "The transport validates input and constructs a user or API Key Principal.",
          "The UOL gateway enforces authorization, plan capabilities, and ownership.",
          "Generation, editing, and masked editing share one image pipeline.",
          "Accepted video jobs stay bound to the original member and token.",
          "Outputs are re-hosted in platform storage before a controlled URL is returned.",
        ],
      },
      {
        id: "pool",
        title: "Unified media backend pool",
        description:
          "Top-level members are API or Adobe. Adobe configuration is further classified as gateway or direct.",
        items: [
          "One admin page manages groups, members, model capabilities, priority, concurrency, and health.",
          "Model IDs are explicit capability keys; scheduling does not infer member type from a prefix.",
          "Each request selects from every eligible member in its group with no sticky session.",
          "Adobe direct accounts and tokens always belong to one unified member.",
        ],
      },
      {
        id: "scheduling",
        title: "Dynamic scheduling",
        description:
          "IMAGE_BACKEND_SCHEDULING_STRATEGY switches the global policy at runtime.",
        items: [
          "priority selects the lowest numeric member priority.",
          "least_acquired selects the member with the fewest acquired leases.",
          "least_load selects the lowest current lease load ratio.",
          "Acquired, switched, no-candidate, capacity-rejected, and terminal outcomes are recorded without request payloads.",
        ],
      },
      {
        id: "video",
        title: "Video recovery and idempotency",
        description:
          "Video tasks are idempotent within the Principal scope and recover across processes through database claims and state versions.",
        items: [
          "The same request key on different API keys creates separate tasks.",
          "A clearly rejected pre-submit attempt may switch to another member.",
          "After pollUrl is stored, only the original member and token are used.",
          "An uncertain submission is retained for diagnosis without automatic retry or refund.",
          "Stable storage and ledger keys make repeated workers converge on one terminal state.",
        ],
      },
      {
        id: "security",
        title: "Security boundaries",
        description:
          "External input, ownership, and upstream destinations are validated fail-closed.",
        items: [
          "Cookie write routes require a trusted Origin; bearer routes use an API Key Principal.",
          "Task ownership checks both userId and apiKeyId.",
          "Adobe direct traffic uses a dedicated proxy with exact Adobe HTTPS hosts.",
          "Proxy requests and health checks share constant-time secret authentication.",
          "Ledger uniqueness and state compare-and-swap protect concurrent execution.",
        ],
      },
    ],
    routes: {
      title: "Active routes",
      description:
        "/v1 and /api/v1 are aliases over the same handlers. External video creation requires clientRequestId.",
      headers: ["Surface", "Method and path", "Purpose"],
      rows: [
        ["Page image", "POST /api/images/generate", "Generate an image"],
        ["Page edit", "POST /api/images/edit", "Edit or mask an image"],
        [
          "Page image status",
          "GET /api/images/status/{id}",
          "Read an owned image task",
        ],
        [
          "Page video",
          "POST /api/videos/generate",
          "Create an idempotent video task",
        ],
        [
          "Page video status",
          "GET /api/videos/{taskId}",
          "Read an owned video task",
        ],
        [
          "External image",
          "POST /v1/images/generations",
          "OpenAI-style image generation",
        ],
        [
          "External edit",
          "POST /v1/images/edits",
          "OpenAI-style image editing",
        ],
        [
          "External image status",
          "GET /v1/images/{taskId}",
          "Read an API-key-owned image task",
        ],
        [
          "External video",
          "POST /v1/videos/generations",
          "Create a persistent video task",
        ],
        [
          "External video status",
          "GET /v1/videos/{taskId}",
          "Read an API-key-owned video task",
        ],
        ["Models", "GET /v1/models", "List available media models"],
        ["Credits", "GET /v1/credits", "Read credits for the API key user"],
      ],
    },
  },
};

/** 选择当前文档语言；未知 locale 使用英文。 */
function getContent(locale: string): DocsContent {
  return locale === "zh" ? contentByLocale.zh : contentByLocale.en;
}

/** 返回 Next.js metadata 所需的稳定标题与描述。 */
export function getSystemDocsMetadata(locale = "en") {
  const content = getContent(locale);
  return { title: content.title, description: content.subtitle };
}

/**
 * 渲染系统文档。
 *
 * @param locale 当前界面语言。
 * @param className 页面容器样式。
 * @returns 与公开文档页和管理员帮助页共用的 React 内容。
 */
export function SystemDocsContent({
  locale = "en",
  className = "container mx-auto max-w-7xl space-y-6 px-4 py-6 md:px-6",
}: {
  locale?: string;
  className?: string;
}) {
  const content = getContent(locale);

  return (
    <div className={className}>
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <CircleHelp className="h-5 w-5 text-muted-foreground" />
          <h1 className="font-serif text-2xl font-medium tracking-tight md:text-3xl">
            {content.title}
          </h1>
        </div>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {content.subtitle}
        </p>
      </header>

      <nav
        aria-label={content.title}
        className="flex gap-2 overflow-x-auto rounded-lg border bg-background/90 p-2"
      >
        {content.sections.map((section, index) => (
          <a
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            href={`#${section.id}`}
            key={section.id}
          >
            <span className="mr-1 font-mono text-[10px]">
              {String(index + 1).padStart(2, "0")}
            </span>
            {section.title}
          </a>
        ))}
        <a
          className="whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          href="#routes"
        >
          {content.routes.title}
        </a>
      </nav>

      <div className="grid gap-4 md:grid-cols-2">
        {content.sections.map((section) => (
          <Card
            className="scroll-mt-24 rounded-lg"
            id={section.id}
            key={section.id}
          >
            <CardHeader>
              <CardTitle className="font-serif text-lg tracking-tight">
                {section.title}
              </CardTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {section.description}
              </p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {section.items.map((item) => (
                  <li className="flex gap-2" key={item}>
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="scroll-mt-24 rounded-lg" id="routes">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.routes.title}
          </CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {content.routes.description}
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {content.routes.headers.map((header) => (
                    <th className="px-3 py-2 font-medium" key={header}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {content.routes.rows.map(([surface, path, purpose]) => (
                  <tr className="border-t" key={path}>
                    <td className="px-3 py-2">{surface}</td>
                    <td className="px-3 py-2 font-mono text-xs">{path}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {purpose}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {["image", "video", "api", "adobe", "priority"].map((label) => (
              <Badge key={label} variant="outline">
                {label}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
