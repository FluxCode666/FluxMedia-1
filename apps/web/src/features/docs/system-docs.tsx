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

import { ApiUpstreamAdapterDocs } from "./api-upstream-adapter-docs";
import {
  DOCUMENTATION_BASE_URL_PLACEHOLDER,
  replaceDocumentationBaseUrl,
} from "./documentation-base-url";

const sections = {
  zh: {
    title: "系统文档",
    subtitle:
      "这里按当前代码真实链路说明：页面入口和外接入口都是协议适配层，不互相 HTTP 调用，最终统一进入同一套生成、扣费、调度和存储链路。默认部署启用自用模式：关闭公开注册，首次启动使用环境变量中的凭据创建超管。",
    flow: {
      title: "请求路由图",
      note: "所有 image/chat/responses 请求统一由平台后端池调度并按平台积分结算。外接接口不会反向请求站内 /api/images/*。",
      entryTitle: "入口",
      resolverTitle: "统一处理",
      groupTitle: "分组选择",
      backendTitle: "后端落点",
      entries: [
        {
          label: "页面文生图",
          path: "POST /api/images/generate",
          kind: "image_generation",
        },
        {
          label: "页面图生图",
          path: "POST /api/images/edit",
          kind: "image_edit",
        },
        {
          label: "页面对话生图",
          path: "POST /api/images/chat",
          kind: "chat",
        },
        {
          label: "页面 Agent 生图",
          path: "POST /api/images/chat",
          kind: "agent",
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
          path: "POST /v1/videos",
          kind: "video",
        },
        {
          label: "外部异步图片任务",
          path: "GET /v1/images/{task_id}",
          kind: "image_generation",
        },
        {
          label: "外部视频任务",
          path: "GET /v1/videos/{id}",
          kind: "video",
        },
        {
          label: "外部对话 API",
          path: "POST /v1/chat/completions",
          kind: "chat",
        },
        {
          label: "外部 Responses API",
          path: "POST /v1/responses",
          kind: "responses",
        },
        {
          label: "外部 Agent 生图 API",
          path: "POST /v1/agents/images",
          kind: "agent",
        },
        {
          label: "外部可编辑 PPT 生成 API",
          path: "POST /v1/ppts",
          kind: "image_generation",
        },
        {
          label: "外部可编辑 PSD 生成 API",
          path: "POST /v1/psds",
          kind: "image_generation",
        },
        {
          label: "外部可编辑文件异步任务",
          path: "GET /v1/editable-file-tasks/{task_id}",
          kind: "image_generation",
        },
      ],
      resolver: [
        "校验登录态或 API 密钥",
        "把页面表单或 OpenAI 兼容请求转换为统一运行参数",
        "计算积分和审核成本",
        "调用 runImageGenerationForUser 进入统一生成链路",
      ],
      groups: [
        "API 密钥绑定分组优先",
        "API 密钥未绑定分组时使用平台默认分组",
        "网页端创作才使用用户在设置里选择的生图后端分组",
        "分组只检查是否启用、内容安全开关和显式模型；队列优先级按分组配置。",
      ],
      backends: [
        {
          title: "Web 账号池",
          description:
            "通过 ChatGPT Web 链路承接页面文生图、图生图和对话生图。",
        },
        {
          title: "Codex/Responses 账号池",
          description:
            "chat / agent / responses 走 Responses 语义（image_generation 工具循环、多轮）。普通图像生成与图生图改走该账号的 /images/generations、/images/edits 直连端点（同一 OAuth 凭据，JSON 体、size 走顶层；图生图的输入图/mask 以 base64 data URL 放在 images[].image_url / mask.image_url），以确定性遵循 size 等尺寸参数；Codex 托管的 image_generation 工具不尊重 size，故纯生成/编辑不再用它（codex images 端点要 JSON,不接受 multipart）。即便上游返回尺寸偏小，最终图也会经自动超分校准补足到目标分辨率（见下「分辨率超分与高清修复」），故 Web/Codex 出图同样支持接近 4K 的目标尺寸。",
        },
        {
          title: "Adobe（Firefly）账号池",
          description:
            "作为统一分组成员按 priority 参与调度。成员必须在 supportedModelIds 中显式声明请求使用的真实模型 ID；客户端不能通过供应商前缀或别名选择成员，调度器也不解析模型前缀。命中后才由 Adobe 适配器转换供应商协议。",
        },
        {
          title: "外接 API 后端",
          description:
            "管理员配置的 OpenAI 兼容 Base URL/API Key；按当前请求类型调用 images 或 responses 端点。",
        },
      ],
    },
    routeTables: {
      title: "入口到后端的映射",
      pageTitle: "页面请求",
      apiTitle: "外接 API 请求",
      headers: ["入口", "站内接口", "调度类型", "后端池行为"],
      apiHeaders: ["入口", "兼容接口", "调度类型", "后端池行为"],
      pageRows: [
        [
          "创作页文生图",
          "/api/images/generate",
          "image_generation",
          "按选中的平台后端分组调度 Web 账号、Codex/Responses 账号或外接 API 后端。",
        ],
        [
          "创作页图生图",
          "/api/images/edit",
          "image_edit",
          "参考图先进入站内接口，再按选中的后端分组调度。",
        ],
        [
          "创作页对话生图",
          "/api/images/chat",
          "chat",
          "按 chat 类型选择后端；可命中 Web 账号、Codex/Responses 账号或支持 /responses 的外接 API 后端。",
        ],
        [
          "创作页 Agent 生图",
          "/api/images/chat",
          "agent",
          "同一站内接口，但强制走 Codex/Responses 能力；默认提供 image_generation、web_search、continue_generation 等工具，并展示工具任务卡。",
        ],
      ],
      apiRows: [
        [
          "OpenAI images generation",
          "/v1/images/generations",
          "image_generation",
          "验证 API 密钥、绑定分组和账户积分后进入同一生成链路；默认返回 b64_json，可显式请求 url。",
        ],
        [
          "OpenAI images edit",
          "/v1/images/edits",
          "image_edit",
          "multipart 图片会被转成统一图片输入，再按分组调度。",
        ],
        [
          "OpenAI-style video",
          "/v1/videos",
          "video",
          "本站扩展。始终创建持久视频任务并返回 HTTP 202；使用响应中的视频任务 ID 轮询 GET /v1/videos/{id}，也可配置 callback_url 接收终态回调。",
        ],
        [
          "Async image task",
          "/v1/images/{task_id}",
          "image_generation",
          "查询 async=true 创建的内存异步任务，任务 30 分钟后自动过期。",
        ],
        [
          "Video task",
          "/v1/videos/{id}",
          "video",
          "按创建接口返回的持久视频任务 ID 查询状态、输入摘要和成功后的产物 URL。",
        ],
        [
          "OpenAI chat completions",
          "/v1/chat/completions",
          "chat",
          "验证 externalApi.chat.completions 后进入页面 Chat 的非 Agent 链路；可命中 Web、Codex/Responses 或支持 /responses 的外接 API 后端。",
        ],
        [
          "OpenAI Responses",
          "/v1/responses",
          "responses",
          "无 tools 时平台补 image_generation；显式传 tools 时必须包含 image_generation。按 responses 类型调度 Codex/Responses 分组或外接 /responses API。",
        ],
        [
          "FluxMedia Agent image run",
          "/v1/agents/images",
          "agent",
          "本站扩展接口。验证 externalApi.agent 能力后走 Codex/Responses 调度，不会选择 Web 后端；可流式返回 Agent 任务事件和多轮成图。",
        ],
        [
          "OpenAI models",
          "/v1/models",
          "-",
          "只返回当前 API 密钥绑定分组及启用成员显式暴露的模型，不触发后端池调度。",
        ],
        [
          "FluxMedia credits",
          "/v1/credits",
          "-",
          "返回当前 API 密钥的限额、已用、剩余以及所属账户余额，不触发后端池调度。",
        ],
      ],
    },
    relationship: {
      title: "外接与页面接口的关系",
      rows: [
        [
          "页面三接口",
          "/api/images/generate、/api/images/edit、/api/images/chat",
          "浏览器登录态入口，只负责页面表单、参考图和站内流式事件适配。",
        ],
        [
          "Agent 模式",
          "/api/images/chat + agentMode=true",
          "页面 Chat 接口内开启 Codex 风格工具循环和自动迭代。",
        ],
        [
          "外接 API 入口",
          "/v1/chat/completions、/v1/images/generations、/v1/images/edits、/v1/videos、/v1/ppts、/v1/psds、/v1/images/{task_id}、/v1/editable-file-tasks/{task_id}、/v1/responses、/v1/agents/images",
          "/api/v1/* 是同一 handler 的别名；只负责 API 密钥、OpenAI 兼容请求和响应格式适配。/v1/ppts、/v1/psds 走独立的可编辑文件链路（Web 账号 + 代码解释器），不汇入 runImageGenerationForUser；支持 async:true + GET /v1/editable-file-tasks/{task_id} 轮询与 callback_url。",
        ],
        [
          "共同核心",
          "runImageGenerationForUser",
          "扣费、审核、排队、账号池选择、错误标记、冷却、失败退款和图片存储都在这一层。",
        ],
        [
          "后端执行",
          "generateImage / editImage / generateChatImage",
          "按命中的成员转换成 ChatGPT Web、Codex/Responses 或外接 API 请求。",
        ],
      ],
      note: "所以关系不是“外接 API 调页面 API”，而是“各入口共享同一个 service 层”。",
    },
    moderationRepair: {
      title: "审核失败自动修剪重试",
      description:
        "开启后，系统检测到本地审核拦截、上游安全拒绝或安全拒绝导致的无图输出时，会先用 Responses 纯文本请求修剪提示词，再在同一个生成任务内重新审核并重新发起生图。",
      valid: [
        "该能力需要至少一个可用的 Codex/Responses 账号，或一个支持 /responses 的外接 API 后端；纯 Web 分组也会临时借用 Responses 后端完成提示词修剪。",
        "最大重试轮数由 IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES 控制，0 表示关闭；IMAGE_MODERATION_PROMPT_REPAIR_ENABLED 可控制总开关。",
        "修剪重试不会新建第二条生成记录，成功后仍按最终图片和原任务计费；状态监控会按第几次修剪统计尝试、成功和失败。",
        "修剪成功时，页面和外接 API 会通过独立说明提示用户“原提示词因审核被拒，系统已进行更多修改后生成本次结果”；该说明不会写入 revised_prompt。",
        "如果没有可用 Responses 后端，或修剪后仍被审核拦截，系统会保留原审核失败信息并按失败结算规则处理。",
      ],
      invalid: [
        "审核服务本身不可用、上游限流、余额不足、模型权限不足等平台或用户请求错误不会触发提示词修剪。",
        "修剪只改写文本提示词，不会修改用户上传的参考图、蒙版或附件内容。",
      ],
    },
    agent: {
      title: "页面 Agent 模式",
      description:
        "Agent 是 Codex 风格自动执行模式。页面端复用 /api/images/chat 并展示任务卡；外接版使用 /v1/agents/images，以 SSE/JSON 形式返回任务事件和图片结果。",
      valid: [
        "仅在 Codex/Responses 能力可用时启用；Web 分支不会开启 Agent 工具循环。",
        "默认工具包含 image_generation、web_search 和 continue_generation；后端不会强制 tool_choice，避免阻断联网和生图等多工具组合。",
        "每轮会展示 Agent 任务卡：联网、工具兼容性调整、生图、流式预览、继续/停止决策等事件。",
        "支持上传文本/代码类附件作为上下文读取；不会读取用户在提示词中写入的服务器本地路径。",
        "可配置最大轮数；开启强制轮数时会跑满用户选择的轮数，否则模型可通过 continue_generation 决定是否继续。",
        "多轮生成的草稿图会作为迭代版本保存，最后一张作为默认最终图。",
        "按量计费：当前 Chat/Agent 轮次基础费用为 0；完成图片按实际输出和审核成本结算。",
      ],
      invalid: [
        "外部 /v1/responses 不等于 Agent；它只做 OpenAI Responses 兼容协议适配，不会自动开启 Agent 工具循环。",
      ],
    },
    externalDocs: {
      title: "外接 API 详细文档",
      subtitle:
        "以下按 OpenAI 官方接口形态整理本站当前支持范围。粗体字段为本站扩展或兼容增强，不属于标准 OpenAI 字段。",
      commonTitle: "通用规则",
      baseUrlTitle: "Base URL",
      examplesTitle: "请求示例",
      responseExampleTitle: "响应示例",
      copyLabel: "复制",
      copiedLabel: "已复制",
      copyFailedLabel: "复制失败",
      common: [
        "所有外接接口都需要 Authorization: Bearer <本站 API 密钥>。",
        "Chat Completions、图片、视频、Responses 和 Agent 接口均校验 API Key、绑定分组和账户积分；是否可用由分组成员与系统开关决定，并统一按量结算。",
        "/api/v1/* 与 /v1/* 使用同一套 handler，只是路径别名。",
        "所有 API 密钥请求均走普通持久化路径，并按接口能力写入生成历史、对象存储、使用记录与续承状态；不提供不记录模式。",
        "平台内容审核级别由管理员集中管理：用户覆盖优先，否则使用全站默认值，缺失或非法值回退到 high。调用方不能通过 API 密钥或请求字段修改；low、medium、high 只改变 Aliyun 审核阈值，OpenAI 审核提供方不随这三档变化。",
        "response_format 控制返回 URL 或 base64；output_format 才控制图片文件格式，二者不是同一个字段。",
        "错误响应采用 OpenAI 风格 error 对象；本站可能额外返回 generation_id、generationId、credits_consumed 方便排查和对账。",
        "API 密钥绑定的后端分组优先；未绑定时使用平台默认分组，再回退默认启用分组。页面创作可在本次请求中选择已授权分组。",
        "图片按实际输出像素归入 1024、1K、2K、4K 固定档位；价格依次读取所选分组的模型覆盖和全局模型价格，再加运行时审核费。视频按模型族、输出分辨率与时长计费，每秒价格依次读取分组分辨率覆盖、分组模型族覆盖、全局分辨率价格与全局模型族兜底；图片和视频均不使用分组倍率。",
        "API 密钥可设置独立积分限额；GET /v1/credits 可查询密钥限额、已用额度和账户余额。",
        "所有页面和外接 API 请求都使用平台后端池，并按平台积分与 API 密钥额度结算。",
        "image 接口的 web_first / webFirst / force_web / forceWeb（chat 对应 mix_web_first）是 Web-first 优先路由，不是硬性只走 Web，且默认开启。开启时（不传或显式 true）按 Web-first 像素区间（IMAGE_FORCE_WEB_MIN_PIXELS / IMAGE_FORCE_WEB_MAX_PIXELS，默认 0.66MP-2MP）判定：尺寸落在区间内才优先 Web、失败回退 Codex/Responses，超出区间（如 4K）则走正常调度；auto 或无法解析的尺寸视为可优先 Web。显式传 false 则不优先 Web。该路由只对 mixed 后端分组生效（纯 Web / 纯 Codex-Responses 分组无此概念）；agent 始终走 Codex/Responses，不受此项影响。",
        "Adobe（Firefly）后端与 API 后端使用同一分组调度规则：只有成员 supportedModelIds 显式声明的真实模型 ID 才能参与候选，客户端模型 ID 不做供应商前缀或别名转换。图片使用模型四档固定价加运行时审核费，视频使用模型族对应分辨率的每秒固定价格。",
        "图片异步任务（async）：body async:true 或 URL ?async=true（等价、不能与 stream 同用）会立即返回 task_... 任务，需用 GET /v1/images/{task_id} 轮询；task_... 为进程内内存对象，30 分钟后过期，服务重启或多实例切换即无法再查询。若需持久查询，改用响应里的 generation_id（gen_...）作为 GET /v1/images/{id} 的路径参数——它从数据库取回，跨重启/多实例都可查（同步请求也可用此方式按 generation_id 复查）。图片 callback_url 是可选的完成回调 webhook。视频接口采用独立持久任务协议：POST /v1/videos 始终返回 HTTP 202 和视频任务 ID，再用 GET /v1/videos/{id} 轮询；body 中的 async 仅为兼容接受，不改变行为，也不支持通过 URL ?async 切换模式。callback_url 会绑定到该持久任务并在终态投递。",
      ],
      officialRefsTitle: "官方参考",
      officialRefs: [
        {
          label: "Chat Completions API",
          href: "https://developers.openai.com/api/reference/chat/create",
        },
        {
          label: "Images API",
          href: "https://developers.openai.com/api/reference/resources/images",
        },
        {
          label: "Responses API",
          href: "https://developers.openai.com/api/reference/resources/responses/methods/create",
        },
        {
          label: "Models API",
          href: "https://developers.openai.com/api/reference/resources/models/methods/list",
        },
        {
          label: "Adobe 路由与兜底调度",
          href: "/docs/adobe-firefly-routing",
        },
        {
          label: "Adobe 兼容转换",
          href: "/docs/adobe-firefly-compat",
        },
      ],
      fieldHeaders: ["字段", "要求", "说明"],
      responseHeaders: ["返回字段", "说明"],
      requestTitle: "请求字段",
      responseTitle: "返回与流式",
      notesTitle: "实现说明",
      customLabel: "本站扩展",
      docs: [
        {
          title: "List models",
          method: "GET",
          path: "/v1/models",
          contentType: "无请求体",
          description:
            "兼容 OpenAI List models，列出当前 API 密钥绑定分组中启用成员显式暴露的图片与真实视频模型 ID。图片生成和编辑必须原样使用这里返回的模型 ID。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/models \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "created": 0,
      "owned_by": "gpt2image"
    }
  ]
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description: "Bearer <本站 API 密钥>。",
            },
          ],
          responses: [
            {
              name: "object",
              description: "固定为 list。",
            },
            {
              name: "data[].id",
              description:
                "模型 ID。包含默认图片模型、Adobe Firefly 图像族 id、真实视频模型 ID、可用的 Chat/Responses 模型，以及已启用 API 供应商配置的模型 ID。",
            },
            {
              name: "data[].object / created / owned_by",
              description: "兼容 OpenAI model object 结构。",
            },
          ],
          notes: [
            "本站当前只实现模型列表，不实现 /v1/models/{model} 详情。",
            "返回模型按 API Key 绑定分组、启用成员的显式模型列表和系统能力开关过滤；未配置可达成员时列表可能为空。",
            "API 后端的「支持的模型 ID」非空时会同时约束该供应商的调度候选；留空的历史后端不受此约束，模型列表仅回退展示其默认模型。",
          ],
        },
        {
          title: "Get credits",
          method: "GET",
          path: "/v1/credits",
          contentType: "无请求体",
          description:
            "查询当前 Bearer API 密钥的限额、已用额度、剩余额度，以及所属账户当前积分余额。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/credits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "credit_balance",
  "account": {
    "balance": 15702.45,
    "total_earned": 20000,
    "total_spent": 4297.55,
    "status": "active"
  },
  "api_key": {
    "credit_limit": 1000,
    "credits_used": 12.7,
    "credits_remaining": 987.3,
    "unlimited": false
  }
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description: "Bearer <本站 API 密钥>。",
            },
          ],
          responses: [
            {
              name: "account.balance",
              description: "所属用户账户当前可用积分余额。",
            },
            {
              name: "account.total_earned / total_spent / status",
              description:
                "账户累计获得 / 消耗积分，及账户状态（active 正常 / frozen 冻结）。",
            },
            {
              name: "api_key.credit_limit",
              description: "当前 API 密钥总限额；null 表示不限额。",
            },
            {
              name: "api_key.credits_used / credits_remaining",
              description:
                "当前 API 密钥已用和剩余额度；不限额时 credits_remaining 为 null。",
            },
          ],
          notes: [
            "API 密钥限额只限制该密钥自身；走本站平台计费路径时仍必须有足够账户积分。",
            "api_key 对象还含 id / name / key_prefix / last_four / is_active / last_used_at / created_at 等字段（示例从略）。",
            "生成失败退款、审核拦截结算和实际尺寸后修正会同步修正 Key 已用额度。",
          ],
        },
        {
          title: "Generate editable PPT / PSD",
          method: "POST",
          path: "/v1/ppts、/v1/psds",
          contentType: "application/json",
          description:
            "对话式驱动 ChatGPT 代码解释器生成可编辑 .pptx / 分层 .psd（含素材 zip）。按任务固定价扣积分（后台可配 EDITABLE_FILE_PPT_CREDITS / EDITABLE_FILE_PSD_CREDITS，默认 25，仅成功扣）。分钟级长任务，用 keep-alive JSON 撑住连接直到出结果。PSD 必须传 base64_images。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/ppts \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt":"2026 Q2 电商运营复盘 PPT，8 页以内"}'`,
          responseExample: `{
  "object": "editable_file_task",
  "taskId": "…",
  "status": "success",
  "kind": "ppt",
  "result": {
    "conversation_id": "…",
    "primary_url": "/api/storage/…/xxx.pptx?sig=…",
    "zip_url": "/api/storage/…/xxx.zip?sig=…"
  },
  "credits_charged": 25
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description:
                "Bearer <本站 API 密钥>；需能力位 export.ppt / export.psd（默认对 free 开放）。",
            },
            {
              name: "prompt",
              requirement: "必填",
              description: "生成需求描述。",
            },
            {
              name: "base64_images",
              requirement: "PSD 必填、PPT 可选",
              description: "参考图 data URL 数组（PSD 至少一张）。",
            },
            {
              name: "client_task_id",
              requirement: "可选",
              description:
                "幂等/审计标识；作扣费 sourceRef（editable-file:{client_task_id}），缺省服务端生成。",
            },
            {
              name: "async",
              requirement: "可选（body async:true 或 URL ?async=true）",
              description:
                "开启后立即返回 task_...，后台生成；用 GET /v1/editable-file-tasks/{task_id} 轮询或 callback_url 回调。分钟级长任务建议异步，避免同步连接被中途掐断。",
            },
            {
              name: "callback_url",
              requirement: "可选",
              description:
                "完成回调 webhook（强制 https + 公网）；任务结束时服务端把任务对象 POST 到该地址。",
            },
          ],
          responses: [
            {
              name: "object / kind / status",
              description:
                "固定 editable_file_task；kind 为 ppt / psd；status 为 success。",
            },
            {
              name: "result.primary_url",
              description: "主产物（.pptx / .psd）签名下载 URL。",
            },
            {
              name: "result.zip_url",
              description: "素材 zip 签名下载 URL（可能为空）。",
            },
            {
              name: "credits_charged",
              description: "本次扣除积分。",
            },
          ],
          notes: [
            "需可用的 Web 账号（代码解释器）；账号池无可用账号时返回 503 no_available_image_backend。",
            "同步（默认）用 keep-alive JSON 撑到出结果；异步（async:true）立即返回 task_...，任务为进程内内存态（30 分钟 TTL、多实例不共享、重启即清；可编辑文件无 DB generation 行，故不作持久回退）。client_task_id 为计费层幂等（防重复扣），任务级幂等为后续迭代。",
            "/api/v1/ppts、/api/v1/psds 为同一 handler 别名；站内 chat(web) tab 走 session 版 /api/editable-file/generate（同一 service）。",
          ],
        },
        {
          title: "Get editable file task",
          method: "GET",
          path: "/v1/editable-file-tasks/{task_id}",
          contentType: "无请求体",
          description:
            "查询 async:true 创建的可编辑文件（PPT/PSD）任务状态。processing / completed / failed；completed 时含 result.primary_url、result.zip_url 与 credits_charged。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/editable-file-tasks/task_xxx \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "id": "task_xxx",
  "object": "editable_file_task",
  "kind": "ppt",
  "status": "completed",
  "result": {
    "primary_url": "/api/storage/…/xxx.pptx?sig=…",
    "zip_url": "/api/storage/…/xxx.zip?sig=…"
  },
  "credits_charged": 25
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description: "Bearer <本站 API 密钥>；只返回归属本人的任务。",
            },
            {
              name: "task_id",
              requirement: "路径参数",
              description: "async 生成返回的 task_...。",
            },
          ],
          responses: [
            {
              name: "status",
              description: "processing / completed / failed。",
            },
            {
              name: "result.primary_url / zip_url",
              description: "completed 时的主产物与素材 zip 签名下载 URL。",
            },
            {
              name: "credits_charged",
              description: "已扣积分（completed）。",
            },
          ],
          notes: [
            "内存任务 30 分钟 TTL、多实例不共享、重启即清；过期或跨实例即 404。",
            "只返回 object=editable_file_task 的任务（与 /v1/images/{id}、/v1/videos/{id} 隔离）。",
          ],
        },
        {
          title: "Create chat completion",
          method: "POST",
          path: "/v1/chat/completions",
          contentType: "application/json",
          description:
            "兼容 OpenAI Chat Completions 的生图对话入口。它复用页面 Chat 的非 Agent 模式，不启用 Agent 工具循环。",
          example: `# 1. 普通对话生图；默认返回 URL，content 中会追加 Markdown 图片链接
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "messages": [
      { "role": "system", "content": "你是专业视觉海报设计师。" },
      { "role": "user", "content": "生成一张科技企业宣传海报，16:9，蓝白配色" }
    ],
    "size": "1536x864",
    "quality": "high",
    "response_format": "url"
  }'

# 2. 多模态输入，image_url 会作为本轮真实参考图输入
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "image_model": "gpt-image-2",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "参考这张产品图，生成一张电商主图" },
          { "type": "image_url", "image_url": { "url": "https://example.com/product.png" } }
        ]
      }
    ],
    "size": "1024x1024",
    "response_format": "url"
  }'

# 3. 流式返回；文本走 chat.completion.chunk，自定义 partial_image 事件返回流式预览
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "user", "content": "生成一张未来城市概念图" }
    ],
    "size": "1024x1024",
    "stream": true
  }'`,
          responseExample: `{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1713833628,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "已生成图片。\\n\\n![generated image 1](${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...)",
        "images": [
          {
            "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
            "revised_prompt": "...",
            "generation_id": "gen_..."
          }
        ]
      },
      "finish_reason": "stop"
    }
  ],
  "images": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "generation_id": "gen_..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 2.31,
  "usage": null
}

# stream=true 时的 SSE 片段
data: {"id":"chatcmpl_...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"正在生成..."},"finish_reason":null}]}

event: chat.completion.partial_image
data: {"type":"chat.completion.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

data: {"id":"chatcmpl_...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"generation_id":"gen_...","credits_consumed":2.31}
`,
          fields: [
            {
              name: "messages",
              requirement: "必填",
              description:
                "OpenAI Chat Completions 消息数组。最后一条 user 文本会作为本轮 prompt，之前的 user/assistant 会作为页面 Chat 历史上下文；system/developer 消息会合并为系统指令（apiPrompt），不计入历史。",
            },
            {
              name: "messages[].content[].image_url",
              requirement: "可选",
              description:
                "支持公网 http(s) 图片 URL 或 data:image URL；最后一条 user 中的图片会作为本轮真实参考图输入。",
            },
            {
              name: "model",
              requirement: "可选",
              description:
                "GPT 对话模型。Web/Codex/Responses 后端会按各自能力处理；不可用模型会返回错误或由后端调度处理。",
            },
            {
              name: "size",
              requirement: "可选",
              description:
                "目标尺寸，非法尺寸返回参数错误；作为本轮 Chat 生图运行参数。",
            },
            {
              name: "quality",
              requirement: "可选",
              description:
                "auto、low、medium、high；作为本轮 Chat 生图运行参数。",
            },
            {
              name: "moderation",
              requirement: "可选",
              description:
                "auto 或 low；作为向上游图像接口传递的本轮 Chat 生图参数，不会修改平台集中管理的内容审核级别。",
            },
            {
              name: "stream",
              requirement: "可选",
              description: "true 时返回 text/event-stream。",
            },
            {
              name: "response_format",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：url 或 b64_json。默认 url，避免 Chat Completions 响应体过大。",
            },
            {
              name: "image_model / imageModel",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：默认支持 gpt-image-*；若管理员在 API 后端配置了自定义上游模型，也可传 nano-banana-*、grok-* 或其他该上游支持的模型。自定义模型只调度到 API 后端，不会映射为 Web 独立图片模型。",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "可选",
              custom: true,
              description: "控制是否使用本站提示词优化。",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：审核改写重试开关。false 时审核失败直接返回真实错误，不自动改写提示词重试；与 /v1/images/generations 同义。",
            },
            {
              name: "background",
              requirement: "可选",
              description:
                "transparent、opaque、auto。与 /v1/images/generations 同义；chat 模式适用，不含 agent 分层。",
            },
            {
              name: "transparent_matte",
              requirement: "可选",
              custom: true,
              description:
                "默认 false。仅当 background=transparent 且显式设为 true 时生效：命中的后端不支持透明返回 400 时自动改不透明重绘，再在服务端用 ISNet 抠图得到透明 PNG；agent 分层模式下不生效。详见 /v1/images/generations 说明。",
            },
            {
              name: "hd_repair / hdRepair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：高清修复。默认 false。设为 true 时最终图用 SCUNet 盲复原（去噪 / 去压缩块 / 增强质感，不改分辨率），与超分放大相互独立、可叠加；需管理端开启修复主开关，CPU 较重、服务端串行排队。与 /v1/images/generations 同义。",
            },
            {
              name: "block_repair / blockRepair、repair_prompt",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：生成式修复。默认 false。整图缩到 web 甜点分辨率后一次性 gpt-image-2 img2img 重绘再超分，重点修文字、无接缝，单独计费；repair_prompt 指定提示词。需管理端开启「生成式修复」主开关。与 /v1/images/generations 同义。",
            },
            {
              name: "thinking / reasoning.effort",
              requirement: "可选",
              custom: true,
              description:
                "minimal、none、low、medium、high、xhigh；主要针对 Codex/Responses 后端。",
            },
            {
              name: "mixWebFirst / mix_web_first",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展（仅 mixed 分组生效）：Web-first 默认开启。开启时（不传或显式 true）按 Web-first 像素区间判定——尺寸落在区间内才优先 Web、失败回退 Codex/Responses，超出区间（如 4K）走正常调度；auto 或无法解析的尺寸视为可优先 Web。显式传 false 则不优先 Web。区间由 IMAGE_FORCE_WEB_MIN_PIXELS / IMAGE_FORCE_WEB_MAX_PIXELS 配置，默认 0.66MP-2MP。",
            },
            {
              name: "requiresResponsesBackend / requires_responses_backend",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：强制本次 Chat 走 Codex/Responses 能力，不走 Web，并按平台后端池结算本站积分。",
            },
          ],
          responses: [
            {
              name: "choices[].message.content",
              description:
                "兼容 Chat Completions 文本内容；当返回 URL 图片时会追加 Markdown 图片链接。",
            },
            {
              name: "choices[].message.images / images",
              description:
                "本站扩展。结构化图片结果，包含 url 或 b64_json、generation_id、revised_prompt。",
              custom: true,
            },
            {
              name: "generation_id / generationId",
              description:
                "本站扩展字段。非流式成功响应在顶层返回本次 Chat 轮次的生成记录 ID。",
              custom: true,
            },
            {
              name: "credits_consumed",
              description:
                "本站扩展字段。本次请求 FluxMedia 结算积分；当前 Chat 轮次基础费用为 0，有图时按实际输出和审核成本结算。",
              custom: true,
            },
            {
              name: "SSE chat.completion.chunk",
              description: "OpenAI 风格 Chat Completions 流式文本块。",
            },
            {
              name: "SSE chat.completion.partial_image",
              description:
                "本站扩展。仅流式模式返回；表示生图过程中的流式预览图片。",
              custom: true,
            },
          ],
          notes: [
            "上游 API 配置有两个独立开关：Images 上游控制 /v1/images/generations 与 /v1/images/edits 命中后请求上游 /images/* 还是转换到 /responses + image_generation tool；Chat Completions 上游只控制 /v1/chat/completions 命中后请求上游 /chat/completions 还是 /responses。",
            "选择 chat_completions 后，本站 /v1/chat/completions 会请求命中上游的 /chat/completions；这更适合纯聊天兼容，但是否能返回图片取决于上游实现。Agent 和 /v1/responses 不受该配置影响。",
            "OpenAI 官方 Chat Completions 并不定义“生成图片”的标准返回字段；本站为了兼容对话生图，在 Chat Completions 外形上扩展 choices[].message.images、顶层 images，并在 content 中追加 Markdown 图片链接。严格按官方生图协议接入时，建议使用 /v1/images/generations、/v1/images/edits 或 /v1/responses。",
            "该接口走页面 Chat 的非 Agent 模式，不会注入 web_search、continue_generation，也不会展示 Agent 多轮任务卡。",
            "调度类型是 chat，可命中 Web 账号、Codex/Responses 账号或支持 /responses 的外接 API 后端。",
            "计费等同页面 Chat：当前 Chat 轮次基础费用为 0；完成图片按实际尺寸和数量结算模型固定价与运行时审核费，图片费用不乘分组倍率。",
          ],
        },
        {
          title: "Create image",
          method: "POST",
          path: "/v1/images/generations",
          contentType: "application/json",
          description:
            "兼容 OpenAI Images generation。请求会转换成 image_generation 调度类型，进入统一生成链路。",
          example: `# 1. 官方 Images 风格，默认返回 b64_json
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A cute baby sea otter",
    "size": "1024x1024",
    "quality": "medium",
    "moderation": "auto",
    "background": "auto"
  }'

# 2. 返回 URL，并关闭本站提示词优化
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-1.5",
    "prompt": "一张赛博朋克城市夜景，雨后霓虹反光",
    "size": "1024x1024",
    "quality": "high",
    "moderation": "low",
    "response_format": "url",
    "output_format": "webp",
    "output_compression": 85,
    "background": "transparent",
    "prompt_optimization": false
  }'

# 3. Codex/Responses 后端专用参数；普通 Images API 后端可能忽略
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "生成一张 16:9 产品海报",
    "size": "1536x864",
    "response_format": "url",
    "output_format": "jpeg",
    "output_compression": 90,
    "gptModel": "gpt-5.4",
    "thinking": "high",
    "promptOptimization": false
  }'

# 4. mixed 分组按可配置像素区间优先尝试 Web；失败或耗尽后降级 Codex/Responses
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张 1:1 头像海报",
    "size": "1024x1024",
    "response_format": "url",
    "web_first": true
  }'

# 5. 流式返回；也可用 Accept: text/event-stream 触发
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张透明玻璃材质的未来感咖啡杯",
    "size": "1024x1024",
    "response_format": "url",
    "stream": true
  }'

# 6. 异步模式；也可在 URL 后追加 ?async=true（与 body async:true 等价）；callback_url 为可选完成回调
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-1.5",
    "prompt": "一张透明背景的产品图标",
    "size": "1024x1024",
    "response_format": "url",
    "output_format": "png",
    "background": "transparent",
    "async": true,
    "callback_url": "https://your-server.example/callback"
  }'

# 7. 本站扩展：透明背景 + ISNet 兜底抠图，并关闭审核改写重试
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "一张透明背景的产品图标",
    "size": "1024x1024",
    "response_format": "url",
    "output_format": "png",
    "background": "transparent",
    "transparent_matte": true,
    "prompt_repair": false
  }'`,
          responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# stream=true 时的 SSE 片段
event: image_generation.partial_image
data: {"type":"image_generation.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: image_generation.completed
data: {"type":"image_generation.completed","index":0,"generation_id":"...","generationId":"...","model":"gpt-image-2","size":"1024x1024","credits_consumed":1.31,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","revised_prompt":"..."}]}

# async=true 的立即响应
{
  "id": "task_...",
  "object": "image.generation",
  "model": "gpt-image-2",
  "status": "processing",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "generation_id": "gen_..."
}

# 查询任务
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/task_... \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"

# 完成后的任务响应或回调 payload
{
  "id": "task_...",
  "object": "image",
  "model": "gpt-image-2",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed": 1713833700,
  "completed_at": "2026-05-28T00:01:12.000Z",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}
`,
          fields: [
            {
              name: "prompt",
              requirement: "必填",
              description: "图片提示词，最多 32000 字符。",
            },
            {
              name: "model",
              requirement: "必填",
              description:
                "图片模型 ID，必须原样取自当前 API 密钥的 GET /v1/models 响应。服务端只在该密钥绑定的可信分组中精确匹配成员显式暴露的 ID，不转换 firefly-* 前缀、default 或其他目录外别名。Responses 对话模型请使用 /v1/responses。",
            },
            {
              name: "size",
              requirement: "可选",
              description:
                "目标尺寸。省略等同于 auto；支持本站分辨率校验规则，非法尺寸会返回参数错误。",
            },
            {
              name: "quality",
              requirement: "可选",
              description: "auto、low、medium、high。",
            },
            {
              name: "moderation",
              requirement: "可选",
              description:
                "auto 或 low；作为向上游图像接口传递的生成参数，不会修改平台集中管理的内容审核级别。",
            },
            {
              name: "response_format",
              requirement: "可选",
              description:
                "url 或 b64_json。默认 b64_json；url 会返回本站存储 URL。",
            },
            {
              name: "output_format",
              requirement: "可选",
              description:
                "png、jpeg、webp。控制实际输出图片格式；不同上游支持情况可能不同。",
            },
            {
              name: "output_compression",
              requirement: "可选",
              description:
                "压缩级别 0-100，仅对 jpeg/webp 有意义；数值越高=压缩越强、文件越小、画质越低（OpenAI 原生 output_compression 语义，本站透传）。",
            },
            {
              name: "background",
              requirement: "可选",
              description:
                "transparent、opaque、auto。透明背景需要命中的上游模型支持，通常还需要 output_format 为 png 或 webp；不支持的模型会返回类似 “Transparent background is not supported for this model” 的 400 错误。若希望在不支持的后端也拿到透明结果，可同时传 transparent_matte=true（见下一项）。无法确认支持时建议使用 auto 或 opaque。",
            },
            {
              name: "transparent_matte",
              requirement: "可选",
              custom: true,
              description:
                "默认 false。仅当 background=transparent 且显式设为 true 时生效：若命中的后端不支持透明而返回 400，则自动改为不透明重新生成，再在服务端用 ISNet 抠图得到透明 PNG。关闭时透明请求直接透传，后端不支持即返回真实 400 错误。注意只对单张生成/编辑/对话生效，不含 agent 分层模式。",
            },
            {
              name: "hd_repair / hdRepair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：高清修复。默认 false。设为 true 时，最终图会用 SCUNet 盲复原（去噪 / 去压缩块 / 增强质感，不改分辨率），与「超分放大」相互独立、可叠加。需管理端开启「高清修复」主开关方生效；CPU 推理较重（512 约 11 秒、1024 约 35 秒）、服务端串行排队，出图更慢。false 或未开启修复时无副作用。",
            },
            {
              name: "block_repair / blockRepair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：生成式修复。默认 false。设为 true 时，最终图缩到 web 甜点分辨率（约 1280），一次性用 gpt-image-2 img2img 整图重绘（重点修文字/细节、保持构图与内容不变），再超分到目标尺寸。整图一次重绘无接缝；额外调用一次后端并单独计费，比超分/高清修复更慢更贵；需管理端开启「生成式修复」主开关方生效。启用成功时替代自动超分。",
            },
            {
              name: "repair_prompt / repairPrompt",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：生成式修复整图 img2img 的提示词。仅在 block_repair=true 时生效；留空则用内置默认（强调只修清晰度与文字、保持构图/内容不变，无需在后台配置）。",
            },
            {
              name: "stream",
              requirement: "可选",
              description: "true 时返回 text/event-stream。",
            },
            {
              name: "async",
              requirement: "可选",
              custom: true,
              description:
                "异步开关。body 传 async:true 或 URL 追加 ?async=true，二选一即可（等价）。开启后立即返回 task_... 任务对象（status:processing），生成在后台执行，需用 GET /v1/images/{task_id} 轮询结果。不能与 stream 同时使用（同传会报错 async cannot be used with stream.）。",
            },
            {
              name: "callback_url",
              requirement: "可选",
              custom: true,
              description:
                "完成回调 webhook（不是给你轮询的地址）。仅异步任务可用：任务完成或失败时，服务端会把最终任务对象 POST 到该 URL，请求头含 X-Tokens-Callback: true、Content-Type: application/json。该 URL 须公网可达且为 http/https。即使任务因 30 分钟过期或服务重启而无法再轮询，已发出的回调不受影响。",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "可选",
              custom: true,
              description:
                "控制平台是否继续优化 prompt。若 prompt 已是优化后的最终提示词，建议传 false。",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "可选",
              custom: true,
              description:
                "审核改写重试开关（issue #24）。默认按平台设置（通常启用）：本地审核拦截或上游安全拒绝导致无图输出时，系统会先用 Responses 改写提示词，再在同一生成任务内重新审核并重试；显式传 false 时关闭该自动改写重试，审核失败直接返回真实错误，不再改写提示词。详见下方“审核失败自动修剪重试”说明。",
            },
            {
              name: "gptModel / gpt_model",
              requirement: "可选",
              custom: true,
              description:
                "当命中 Codex/Responses 账号池时，作为 Responses 顶层 GPT 模型；普通 Images API 后端可能忽略。",
            },
            {
              name: "thinking",
              requirement: "可选",
              custom: true,
              description:
                "minimal、none、low、medium、high、xhigh。仅针对 Codex/Responses 后端；Web 或普通 Images API 后端可能忽略。",
            },
            {
              name: "web_first / webFirst / force_web / forceWeb",
              requirement: "可选",
              custom: true,
              description:
                "仅 image 接口支持。推荐使用 web_first / webFirst；force_web / forceWeb 保留兼容，但实际语义同样是 Web-first 优先路由，不是硬性只走 Web。命中的后端分组为 mixed，且请求尺寸总像素在 IMAGE_FORCE_WEB_MIN_PIXELS 到 IMAGE_FORCE_WEB_MAX_PIXELS 之间时，优先调度 Web 账号。Web 不可用、失败或耗尽后会降级 Codex/Responses。默认区间为 0.66MP-2MP；非 mixed 或不在区间内会忽略该字段。",
            },
          ],
          responses: [
            {
              name: "created",
              description: "Unix 秒时间戳。",
            },
            {
              name: "data[].b64_json / data[].url",
              description: "按 response_format 返回 base64 或 URL。",
            },
            {
              name: "data[].revised_prompt",
              description: "上游返回的改写提示词，若有则返回。",
            },
            {
              name: "generation_id / generationId",
              description:
                "本站扩展字段。非流式成功响应会在顶层返回本次生成记录 ID。",
              custom: true,
            },
            {
              name: "credits_consumed",
              description: "本站扩展字段。本次请求 FluxMedia 结算积分。",
              custom: true,
            },
            {
              name: "SSE image_generation.partial_image",
              description:
                "仅 stream=true 或 Accept: text/event-stream 时返回；表示一张局部图片。",
            },
            {
              name: "SSE image_generation.completed",
              description:
                "仅流式模式返回；表示单张图片已完成，事件 data 会带 generation_id、credits_consumed、model、size 和最终图片。",
            },
          ],
          notes: [
            "该接口不会调用页面 /api/images/generate，而是直接进入共享 service 层。",
            "如果命中 Responses 账号池，内部会把图片请求转换成 Responses image_generation tool 请求。",
            "每次请求固定创建一条生成记录；显式传入 n 会返回 400，不再支持批量生图。",
            "并发与排队：任务同时受全站执行并发和用户生图并发限制；用户默认并发为 20，可在用户编辑页单独覆盖。异步任务按后端分组 priority 数值升序进入持久队列，数值越小优先级越高。",
            "排队等待阶段不会创建 generation，也不会扣图像生成积分；底层队列排队超过 IMAGE_GENERATION_QUEUE_TIMEOUT_MS 会返回 429 类错误。单张任务开始执行后才进入 20 分钟运行超时，运行超时按失败结算规则处理积分。",
            "Web 后端无法严格控制输出尺寸和输出格式；本站保存时会按实际图片头识别扩展名和 MIME。",
            "background=transparent 并非所有模型都支持；OpenAI 官方文档当前列出 gpt-image-1.5、gpt-image-1、gpt-image-1-mini 支持透明背景，且通常还要求 png 或 webp 输出。不支持的上游可能直接返回 HTTP 400，而不是自动降级。",
            "async 任务持久化到 PostgreSQL 并由 BullMQ 唤醒；服务重启、多实例切换或短暂投递失败后会由恢复任务继续收敛。",
            "如果实际生成尺寸与请求尺寸不一致，本站会按检测到的实际尺寸修正记录和计费。",
            "官方 Images API 可能返回 usage；本站当前 usage 通常为 null，但会通过顶层 credits_consumed、错误对象或流式完成事件返回本站结算积分。",
          ],
        },
        {
          title: "Create image edit",
          method: "POST",
          path: "/v1/images/edits",
          contentType: "multipart/form-data 或 application/json",
          description:
            "兼容 OpenAI Images edit。multipart 可上传图片；JSON 可使用公网图片 URL。",
          example: `# 1. multipart 上传参考图
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-2" \\
  -F prompt="把参考图改成电影海报风格" \\
  -F size="1024x1024" \\
  -F quality="high" \\
  -F moderation="auto" \\
  -F response_format="url" \\
  -F output_format="jpeg" \\
  -F output_compression="90" \\
  -F background="opaque" \\
  -F 'image[]=@/path/to/reference.png'

# 2. multipart 多参考图 + mask + Codex/Responses 参数
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-2" \\
  -F prompt="只重绘 mask 区域，保持人物脸部不变" \\
  -F size="1536x1024" \\
  -F quality="medium" \\
  -F response_format="b64_json" \\
  -F promptOptimization="false" \\
  -F gpt_model="gpt-5.4" \\
  -F thinking="medium" \\
  -F 'image[]=@/path/to/person.png' \\
  -F 'image_2=@/path/to/style.png' \\
  -F mask="@/path/to/mask.png"

# 3. JSON 图片 URL；推荐 images，image_url/image_urls 只是兼容快捷字段
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "把参考图改成干净的电商主图",
    "images": [
      "https://example.com/reference.png",
      { "image_url": "https://example.com/detail.webp" }
    ],
    "image_url": "https://example.com/single-reference.png",
    "image_urls": ["https://example.com/extra.jpg"],
    "mask_url": "https://example.com/mask.png",
    "mask_image_url": "https://example.com/mask-alt.png",
    "size": "1024x1024",
    "quality": "auto",
    "moderation": "low",
    "response_format": "url",
    "output_format": "webp",
    "output_compression": 80,
    "background": "transparent",
    "prompt_optimization": false,
    "gptModel": "gpt-5.4-mini",
    "thinking": "low"
  }'

# 4. mixed 分组按可配置像素区间优先尝试 Web；失败或耗尽后降级 Codex/Responses
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "保留人物，改成电影剧照质感",
    "images": ["https://example.com/reference.png"],
    "size": "1024x1024",
    "response_format": "url",
    "web_first": true
  }'

# 5. 流式图生图
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -F model="gpt-image-2" \\
  -F prompt="保留构图，改成水彩插画风格" \\
  -F size="1024x1024" \\
  -F response_format="url" \\
  -F stream="true" \\
  -F 'image=@/path/to/reference.png'

# 6. 异步图生图；也可在 URL 后追加 ?async=true（与 body async:true 等价）；callback_url 为可选完成回调
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-1.5" \\
  -F prompt="去除背景，输出透明 PNG" \\
  -F size="1024x1024" \\
  -F response_format="url" \\
  -F output_format="png" \\
  -F background="transparent" \\
  -F async="true" \\
  -F callback_url="https://your-server.example/callback" \\
  -F 'image=@/path/to/reference.png'`,
          responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# stream=true 时的 SSE 片段
event: image_edit.partial_image
data: {"type":"image_edit.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: image_edit.completed
data: {"type":"image_edit.completed","index":0,"generation_id":"...","generationId":"...","model":"gpt-image-2","size":"1024x1024","credits_consumed":1.31,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","revised_prompt":"..."}]}

# async=true 的任务查询和回调响应格式同 /v1/images/generations
`,
          fields: [
            {
              name: "prompt",
              requirement: "必填",
              description: "编辑提示词，最多 32000 字符。",
            },
            {
              name: "image / image[] / image_*",
              requirement: "multipart 必填",
              description: "参考图文件，最多 16 张。",
            },
            {
              name: "images",
              requirement: "JSON 可选",
              description:
                "图片引用数组。本站支持字符串 URL 或 { image_url/url }；file_id 当前不支持。",
            },
            {
              name: "mask",
              requirement: "可选",
              description: "PNG mask 文件；JSON 中可传 URL 形式的 mask 引用。",
            },
            {
              name: "model",
              requirement: "必填",
              description:
                "图片模型 ID，必须原样取自当前 API 密钥的 GET /v1/models 响应；目录外 ID、firefly-* 前缀和其他别名不会被转换。取值范围与调度规则同 /v1/images/generations。",
            },
            {
              name: "size",
              requirement: "可选",
              description: "目标尺寸；省略等同于 auto。",
            },
            {
              name: "quality",
              requirement: "可选",
              description: "auto、low、medium、high。",
            },
            {
              name: "moderation",
              requirement: "可选",
              description:
                "auto 或 low；作为向上游图像接口传递的编辑参数，不会修改平台集中管理的内容审核级别。",
            },
            {
              name: "response_format",
              requirement: "可选",
              description: "url 或 b64_json。默认 b64_json。",
            },
            {
              name: "output_format",
              requirement: "可选",
              description:
                "png、jpeg、webp。控制实际输出图片格式；不同上游支持情况可能不同。",
            },
            {
              name: "output_compression",
              requirement: "可选",
              description:
                "压缩级别 0-100，仅对 jpeg/webp 有意义；数值越高=压缩越强、文件越小、画质越低（OpenAI 原生 output_compression 语义，本站透传）。",
            },
            {
              name: "background",
              requirement: "可选",
              description:
                "transparent、opaque、auto。透明背景需要命中的上游模型支持，通常还需要 output_format 为 png 或 webp；不支持的模型会返回类似 “Transparent background is not supported for this model” 的 400 错误。若希望在不支持的后端也拿到透明结果，可同时传 transparent_matte=true（见下一项）。无法确认支持时建议使用 auto 或 opaque。",
            },
            {
              name: "transparent_matte",
              requirement: "可选",
              custom: true,
              description:
                "默认 false。仅当 background=transparent 且显式设为 true 时生效：若命中的后端不支持透明而返回 400，则自动改为不透明重新生成，再在服务端用 ISNet 抠图得到透明 PNG。关闭时透明请求直接透传，后端不支持即返回真实 400 错误。注意只对单张生成/编辑/对话生效，不含 agent 分层模式。",
            },
            {
              name: "hd_repair / hdRepair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：高清修复。默认 false。设为 true 时，最终图会用 SCUNet 盲复原（去噪 / 去压缩块 / 增强质感，不改分辨率），与「超分放大」相互独立、可叠加。需管理端开启「高清修复」主开关方生效；CPU 推理较重（512 约 11 秒、1024 约 35 秒）、服务端串行排队，出图更慢。false 或未开启修复时无副作用。",
            },
            {
              name: "block_repair / blockRepair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：生成式修复。默认 false。设为 true 时，最终图缩到 web 甜点分辨率（约 1280），一次性用 gpt-image-2 img2img 整图重绘（重点修文字/细节、保持构图与内容不变），再超分到目标尺寸。整图一次重绘无接缝；额外调用一次后端并单独计费，比超分/高清修复更慢更贵；需管理端开启「生成式修复」主开关方生效。启用成功时替代自动超分。",
            },
            {
              name: "repair_prompt / repairPrompt",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：生成式修复整图 img2img 的提示词。仅在 block_repair=true 时生效；留空则用内置默认（强调只修清晰度与文字、保持构图/内容不变，无需在后台配置）。",
            },
            {
              name: "stream",
              requirement: "可选",
              description: "true 时返回 text/event-stream。",
            },
            {
              name: "async",
              requirement: "可选",
              custom: true,
              description:
                "异步开关。body 传 async:true 或 URL 追加 ?async=true，二选一即可（等价）。开启后立即返回 task_... 任务对象（status:processing），编辑在后台执行，需用 GET /v1/images/{task_id} 轮询结果。不能与 stream 同时使用（同传会报错 async cannot be used with stream.）。",
            },
            {
              name: "callback_url",
              requirement: "可选",
              custom: true,
              description:
                "完成回调 webhook（不是给你轮询的地址）。仅异步任务可用：任务完成或失败时，服务端会把最终任务对象 POST 到该 URL，请求头含 X-Tokens-Callback: true、Content-Type: application/json。该 URL 须公网可达且为 http/https。即使任务因 30 分钟过期或服务重启而无法再轮询，已发出的回调不受影响。",
            },
            {
              name: "image_url / image_urls",
              requirement: "JSON 或表单可选",
              custom: true,
              description:
                "兼容快捷字段。推荐使用 images；若同时传入，本站会合并到同一参考图列表并按 URL 去重。",
            },
            {
              name: "mask_url / mask_image_url",
              requirement: "JSON 或表单可选",
              custom: true,
              description: "本站便捷写法：直接传 mask 图片 URL。",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "可选",
              custom: true,
              description:
                "控制平台是否继续优化 prompt。若 prompt 已是优化后的最终提示词，建议传 false。",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "可选",
              custom: true,
              description:
                "审核改写重试开关（issue #24）。默认按平台设置（通常启用）：本地审核拦截或上游安全拒绝导致无图输出时，系统会先用 Responses 改写提示词，再在同一生成任务内重新审核并重试；显式传 false 时关闭该自动改写重试，审核失败直接返回真实错误，不再改写提示词。详见下方“审核失败自动修剪重试”说明。",
            },
            {
              name: "gptModel / gpt_model",
              requirement: "可选",
              custom: true,
              description: "同文生图接口。",
            },
            {
              name: "thinking",
              requirement: "可选",
              custom: true,
              description:
                "minimal、none、low、medium、high、xhigh。仅针对 Codex/Responses 后端；Web 或普通 Images API 后端可能忽略。",
            },
            {
              name: "web_first / webFirst / force_web / forceWeb",
              requirement: "可选",
              custom: true,
              description:
                "仅 image 接口支持。推荐使用 web_first / webFirst；force_web / forceWeb 保留兼容，但实际语义同样是 Web-first 优先路由，不是硬性只走 Web。命中的后端分组为 mixed，且请求尺寸总像素在 IMAGE_FORCE_WEB_MIN_PIXELS 到 IMAGE_FORCE_WEB_MAX_PIXELS 之间时，优先调度 Web 账号。Web 不可用、失败或耗尽后会降级 Codex/Responses。默认区间为 0.66MP-2MP；非 mixed 或不在区间内会忽略该字段。",
            },
          ],
          responses: [
            {
              name: "created / data[]",
              description: "与 /v1/images/generations 相同。",
            },
            {
              name: "generation_id / generationId",
              description:
                "本站扩展字段。非流式成功响应会在顶层返回本次生成记录 ID。",
              custom: true,
            },
            {
              name: "credits_consumed",
              description: "本站扩展字段。本次请求 FluxMedia 结算积分。",
              custom: true,
            },
            {
              name: "SSE image_edit.partial_image",
              description:
                "仅 stream=true 或 Accept: text/event-stream 时返回；表示一张局部编辑图片。",
            },
            {
              name: "SSE image_edit.completed",
              description:
                "仅流式模式返回；表示单张编辑图片已完成，事件 data 会带 generation_id、credits_consumed、model、size 和最终图片。",
            },
          ],
          notes: [
            "URL 图片会先由本站服务端下载并校验公网可访问性、类型和大小。",
            "不支持私网、localhost、metadata/internal 域名或带用户名密码的 URL。",
            "官方 JSON file_id 图片引用当前未实现，请使用公网 image_url 或 multipart 上传。",
            "background=transparent 并非所有模型都支持；OpenAI 官方文档当前列出 gpt-image-1.5、gpt-image-1、gpt-image-1-mini 支持透明背景，且通常还要求 png 或 webp 输出。不支持的上游可能直接返回 HTTP 400，而不是自动降级。",
            "async 任务当前为进程内状态，30 分钟后过期；服务重启或多实例切换会导致未完成任务无法继续查询，callback 已发送的结果不受影响。",
          ],
        },
        {
          title: "Get async image task",
          method: "GET",
          path: "/v1/images/{task_id}",
          contentType: "无请求体",
          description:
            "本站扩展：按 ID 查询一次图片生成。路径参数可传两类 ID：（1）async=true 创建的 task_...（进程内内存任务对象，30 分钟后过期、服务重启或多实例切换即查不到）；（2）任意同步/异步响应返回的 generation_id（gen_...，从数据库持久取回，跨重启/多实例都可查）。先查内存任务，未命中再按 generation_id 查库。仅返回归属本人的记录。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/task_... \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "id": "task_...",
  "object": "image",
  "model": "gpt-image-2",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed": 1713833700,
  "completed_at": "2026-05-28T00:01:12.000Z",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# 仍在执行时（status:processing 暂无 data）
{
  "id": "task_...",
  "object": "image.generation",
  "model": "gpt-image-2",
  "status": "processing",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "generation_id": "gen_..."
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description: "Bearer <本站 API 密钥>。",
            },
            {
              name: "task_id",
              requirement: "必填路径参数",
              custom: true,
              description:
                "ID（路径参数）。可传 async=true 返回的 task_...（内存任务，30 分钟过期、重启/多实例后查不到），或任意响应返回的 generation_id（gen_...，从数据库持久取回，跨重启/多实例可查）。长度上限 128 字符，缺失/超长返回 400 Invalid task_id.，未找到/已过期返回 404。均按归属用户隔离，只返回本人的记录。",
            },
          ],
          responses: [
            {
              name: "id",
              description:
                "任务 ID（task_...），与请求路径中的 {task_id} 一致。",
            },
            {
              name: "object",
              description: "执行中为 image.generation，完成后为 image。",
            },
            {
              name: "status",
              description:
                "任务状态，取值 processing（执行中）、completed（成功）或 failed（失败，对象内含 error）。",
            },
            {
              name: "data",
              description:
                "status=completed 时返回图片结果数组（与 /v1/images/generations 响应一致，元素含 url 或 b64_json）；执行中尚无该字段。",
            },
            {
              name: "created / created_at / completed / completed_at",
              description:
                "任务创建与完成时间（秒级时间戳与 ISO 字符串）；completed* 仅在完成后出现。",
            },
            {
              name: "generation_id / generationId",
              description: "关联的单条生成记录 ID。",
            },
            {
              name: "credits_consumed",
              description: "完成后结算的本站积分。",
            },
          ],
          notes: [
            "任务持久化到 PostgreSQL 并由 BullMQ 唤醒；服务重启、多实例切换或短暂投递失败后会由恢复任务继续处理。",
            "只能查询属于当前 API 密钥所属用户自己创建的任务。",
            "返回结构与 callback_url 回调 POST 的任务对象完全一致。",
          ],
        },
        {
          title: "Create video",
          method: "POST",
          path: "/v1/videos",
          contentType: "application/json",
          description:
            "按 OpenAI 风格创建地址创建持久视频任务。请求始终在任务持久化后返回 HTTP 202 和 object=video.task，不会在当前连接中等待出片；使用返回的视频任务 ID 轮询 GET /v1/videos/{id}，或通过 callback_url 接收终态回调。鉴权与其他 v1 接口一致（API 密钥）。",
          example: `# 1. 文生视频；model 只传真实模型 ID，其他参数独立传递
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-001",
    "model": "veo31",
    "seconds": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "prompt": "一只柯基在海边奔跑，电影级运镜，黄昏光线",
    "negative_prompt": "低分辨率, 模糊, 水印"
  }'

# 2. 首尾帧生成；首尾帧与参考图对所有模型互斥
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-002",
    "model": "seedance2-fast",
    "duration_seconds": 10,
    "aspect_ratio": "9:16",
    "resolution": "720p",
    "prompt": "让画面中的人物缓缓抬头微笑",
    "first_frame": "data:image/png;base64,iVBORw0KGgo...",
    "last_frame": "data:image/png;base64,iVBORw0KGgo...",
    "generate_audio": false
  }'

# 3. 兼容 async 字段；无论 true 或 false，接口都返回同一种持久任务
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-003",
    "model": "veo31",
    "seconds": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "prompt": "城市夜景延时，霓虹倒影",
    "async": true,
    "callback_url": "https://your-server.example/callback"
  }'
# 返回 HTTP 202；随后使用同一持久任务 ID 轮询（或等待 callback_url 回调）：
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/video_0123456789abcdef0123456789abcdef01234567 \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "queued",
  "model": "veo31",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p"
}`,
          fields: [
            {
              name: "prompt",
              requirement: "必填",
              description: "视频提示词，最多 32000 字符。",
            },
            {
              name: "model",
              requirement: "必填",
              description:
                "真实视频模型 ID，例如 seedance2、seedance2-fast、veo31。不得在模型 ID 中拼接时长、比例或分辨率；旧 firefly-* 与复合 ID 会被拒绝。可用模型见 /v1/models。",
            },
            {
              name: "clientRequestId / client_request_id",
              requirement: "必填",
              description:
                "调用方生成的幂等请求 ID，最长 128 字符；重试同一请求时必须复用。",
            },
            {
              name: "seconds / duration / duration_seconds",
              requirement: "必填",
              description: "视频时长（秒），必须是所选真实模型支持的整数值。",
            },
            {
              name: "aspectRatio / aspect_ratio",
              requirement: "必填",
              description:
                "视频宽高比，例如 16:9、9:16；必须属于所选模型能力。",
            },
            {
              name: "resolution",
              requirement: "必填",
              description:
                "小写分辨率，例如 480p、720p、1080p；必须属于所选模型能力。",
            },
            {
              name: "negative_prompt / negativePrompt",
              requirement: "可选",
              description: "负向提示词，最多 8000 字符。",
            },
            {
              name: "firstFrame / first_frame、lastFrame / last_frame",
              requirement: "可选",
              description:
                "首帧与可选尾帧，值为 base64 image data URL。尾帧必须与首帧同时提供；是否支持尾帧由模型能力决定。",
            },
            {
              name: "referenceImages / reference_images",
              requirement: "可选",
              description:
                "有序参考图 base64 data URL 数组；数量上限由模型能力决定，Seedance 默认 10 且管理员可配置。参考图与首尾帧对所有模型互斥。",
            },
            {
              name: "generateAudio / generate_audio",
              requirement: "可选",
              description: "是否生成声音；仅支持声音能力的模型可设为 true。",
            },
            {
              name: "async",
              requirement: "可选",
              custom: true,
              description:
                "兼容字段。true、false 或省略都会创建同一种持久任务并返回 HTTP 202；不会切换同步模式。视频接口不支持用 URL ?async 改变行为。",
            },
            {
              name: "callback_url / callbackUrl",
              requirement: "可选",
              custom: true,
              description:
                "持久任务终态回调 webhook。任务完成或失败时服务端向该公网 https 地址 POST 终态结果；与 async 字段无关，重试同一 clientRequestId 时必须保持回调地址一致。",
            },
          ],
          responses: [
            {
              name: "object",
              description: "固定为 video.task。",
            },
            {
              name: "id / task_id / generation_id",
              description: "同一个持久视频任务 ID，用于 GET /v1/videos/{id}。",
            },
            {
              name: "status",
              description:
                "任务创建后的当前状态：queued、in_progress、completed 或 failed。",
            },
            {
              name: "model",
              description: "本次使用的真实视频模型 ID。",
            },
            {
              name: "duration / duration_seconds、aspectRatio / aspect_ratio、resolution",
              description: "本次持久任务保存的独立生成参数。",
            },
            {
              name: "generateAudio / generate_audio",
              description: "创建请求显式提供声音开关时返回这两个等价值。",
            },
          ],
          notes: [
            "该接口是本站扩展，不是 OpenAI 官方接口；/api/v1/videos 是同一 handler 的别名。",
            "所有请求都在任务持久化后立即返回 HTTP 202；没有同步等待模式，也不支持用 URL ?async 切换模式。",
            "callback_url 绑定到持久任务并在终态投递；同一 clientRequestId 的幂等重试不能更换或追加回调地址。",
            "计费 = 当前真实模型与输出分辨率对应的每秒积分 × 独立 duration（秒），最终结果按积分精度向上取整。模型、时长、比例和分辨率分别校验，不从 model ID 解析参数。",
            "需要 externalApi.images.generate 系统能力开关；同时校验 API Key、绑定分组和账户积分。",
          ],
        },
        {
          title: "Get video task",
          method: "GET",
          path: "/v1/videos/{id}",
          contentType: "无请求体",
          description:
            "本站扩展：按创建接口返回的持久视频任务 ID 查询状态。接口只查询数据库中的视频任务并校验 API 密钥归属，不读取进程内异步任务。",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/video_0123456789abcdef0123456789abcdef01234567 \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "completed",
  "model": "veo31",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "generateAudio": false,
  "generate_audio": false,
  "input": {"mode": "none", "count": 0},
  "video_url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed_at": "2026-05-28T00:01:40.000Z"
}

# 仍在执行时不会返回 video_url 或 data
{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "model": "veo31",
  "status": "in_progress",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "generateAudio": false,
  "generate_audio": false,
  "input": {"mode": "none", "count": 0},
  "created_at": "2026-05-28T00:00:00.000Z"
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "必填 header",
              description: "Bearer <本站 API 密钥>。",
            },
            {
              name: "id",
              requirement: "必填路径参数",
              custom: true,
              description:
                "创建接口响应中的 id、task_id 或 generation_id；三者是同一个持久视频任务 ID。长度上限 128 字符，缺失或超长返回 400 Invalid task_id.，并按 API 密钥所有者隔离。",
            },
          ],
          responses: [
            {
              name: "object",
              description: "固定为 video.task。",
            },
            {
              name: "id / task_id / generation_id",
              description: "同一个持久视频任务 ID，与请求路径中的 {id} 一致。",
            },
            {
              name: "status",
              description:
                "queued、in_progress、completed 或 failed；存在失败原因时返回 error.message。",
            },
            {
              name: "model、duration / duration_seconds、aspectRatio / aspect_ratio、resolution",
              description: "持久任务保存的真实模型 ID 和独立生成参数。",
            },
            {
              name: "generateAudio / generate_audio",
              description: "任务实际使用的声音开关。",
            },
            {
              name: "input.mode / input.count",
              description:
                "输入摘要；mode 为 none、first-frame、first-last-frames 或 references，count 为输入图数量，不返回实际输入图。",
            },
            {
              name: "data[].url / video_url",
              description:
                "status=completed 时返回产物视频的本站存储签名 URL（data[].url 与顶层 video_url 等价）；执行中尚无该字段。",
            },
            {
              name: "created_at / completed_at",
              description:
                "ISO 格式的任务创建时间；completed_at 仅在完成后出现。",
            },
          ],
          notes: [
            "该接口是本站扩展，不是 OpenAI 官方接口；/api/v1/videos/{id} 是同一 handler 的别名。",
            "只能查询属于当前 API 密钥所属用户自己创建的任务；响应 Cache-Control: no-store。",
            "任务状态和产物来自持久视频记录，不存在 30 分钟内存任务过期语义。",
          ],
        },
        {
          title: "Create Agent image run",
          method: "POST",
          path: "/v1/agents/images",
          contentType: "application/json 或 multipart/form-data",
          description:
            "本站扩展接口：把页面 Agent 模式开放给外接 API。它固定按 Codex/Responses 能力调度，支持联网、工具循环、自动迭代、附件上下文和流式 Agent 事件。",
          example: `# 1. JSON Agent 生图；默认返回 URL。需要启用 externalApi.agent 系统能力。
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "prompt": "联网查询浙江双元科技公开资料，迭代生成一张企业宣传海报",
    "size": "1536x1024",
    "quality": "high",
    "thinking": "medium",
    "agent_max_rounds": 3,
    "agent_force_max_rounds": false,
    "response_format": "url"
  }'

# 2. 带参考图 URL。images / image_url / image_urls 会合并去重。
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "image_model": "gpt-image-2",
    "prompt": "参考这张产品图，先分析卖点，再生成一张电商海报",
    "images": ["https://example.com/product.png"],
    "size": "1024x1024",
    "agent_max_rounds": 2
  }'

# 3. multipart 上传参考图和 PDF/文本附件。
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-5.4" \\
  -F image_model="gpt-image-2" \\
  -F prompt="阅读附件资料并生成一张展会宣传海报" \\
  -F size="1536x1024" \\
  -F response_format="url" \\
  -F agent_max_rounds="3" \\
  -F 'image[]=@/path/to/reference.png' \\
  -F 'file=@/path/to/company-profile.pdf'

# 4. 流式 Agent。会持续返回 agent.event / agent.partial_image / agent.completed。
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "prompt": "先搜索资料，再迭代生成一张科技蓝企业海报",
    "size": "1536x1024",
    "stream": true,
    "agent_max_rounds": 2,
    "agent_force_max_rounds": true
  }'`,
          responseExample: `{
  "object": "agent.image_run",
  "created": 1713833628,
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "model": "gpt-5.4",
  "size": "1536x1024",
  "response_text": "已完成资料检索并生成海报。",
  "agent_round_count": 2,
  "credits_consumed": 8.42,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "...",
      "output_role": "agent_draft"
    },
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "...",
      "output_role": "final"
    }
  ],
  "agent_events": [],
  "usage": null
}

# stream=true 时的 SSE 片段
event: agent.event
data: {"type":"agent.event","event":{"kind":"web_search","status":"completed","title":"联网搜索完成","detail":"浙江双元科技 官网"}}

event: agent.partial_image
data: {"type":"agent.partial_image","partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: agent.completed
data: {"type":"agent.completed","generation_id":"...","generationId":"...","agent_round_count":2,"credits_consumed":8.42,"data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","output_role":"final"}]}
`,
          fields: [
            {
              name: "prompt",
              requirement: "必填",
              description: "Agent 当前任务，最多 32000 字符。",
            },
            {
              name: "model / gptModel / gpt_model",
              requirement: "可选",
              description:
                "Agent 顶层 GPT/Responses 模型。若 model 是 gpt-image-*，本站会把它当作 image_model 兼容处理。",
            },
            {
              name: "image_model / imageModel",
              requirement: "可选",
              description:
                "image_generation 工具使用的图片模型，通常为 gpt-image-*。",
            },
            {
              name: "images / image_url / image_urls",
              requirement: "JSON 可选",
              description:
                "公网参考图 URL；也支持 data URL。本站会服务端下载并校验公网可达、类型和大小。",
            },
            {
              name: "image / image[] / image_*",
              requirement: "multipart 可选",
              description: "参考图文件和附件总数受系统媒体参数限制。",
            },
            {
              name: "file / file[] / attachment",
              requirement: "multipart 可选",
              description:
                "文本、代码、CSV、JSON、Markdown、XML、YAML、日志或 PDF 附件。文本类会转成上下文，PDF 会作为 Responses 文件输入。",
            },
            {
              name: "history",
              requirement: "可选",
              description:
                "前序对话数组，形如 [{ role, text, imageUrls, variants }]；用于继续外接 Agent 会话。",
            },
            {
              name: "agent_max_rounds",
              requirement: "可选",
              description: "1 到 8。限制本次 Agent 自动迭代轮数。",
              custom: true,
            },
            {
              name: "agent_force_max_rounds",
              requirement: "可选",
              description:
                "true 时强制跑满 agent_max_rounds；false 时模型可通过 continue_generation 自行停止。",
              custom: true,
            },
            {
              name: "size",
              requirement: "可选",
              description:
                "目标尺寸，非法尺寸返回参数错误；作为 Agent 内 image_generation 工具运行参数。",
            },
            {
              name: "quality",
              requirement: "可选",
              description:
                "auto、low、medium、high；作为 Agent 内 image_generation 工具运行参数。",
            },
            {
              name: "moderation",
              requirement: "可选",
              description:
                "auto 或 low；作为 Agent 内 image_generation 工具的上游生成参数，不会修改平台集中管理的内容审核级别。",
            },
            {
              name: "output_format",
              requirement: "可选",
              description:
                "png、jpeg、webp，控制输出图片格式；作为 Agent 内 image_generation 工具运行参数。",
            },
            {
              name: "output_compression",
              requirement: "可选",
              description:
                "压缩级别 0-100，仅对 jpeg/webp 有意义，数值越高=压缩越强、文件越小、画质越低（OpenAI 原生语义，本站透传）；作为 Agent 内 image_generation 工具运行参数。",
            },
            {
              name: "background",
              requirement: "可选",
              description:
                "transparent、opaque、auto。与 /v1/images/generations 同义。",
            },
            {
              name: "transparent_matte",
              requirement: "可选",
              custom: true,
              description:
                "默认 false。仅当 background=transparent 且设为 true 时：后端不支持透明返回 400 时自动改不透明重绘并用 ISNet 抠图得到透明 PNG；注意 agent 分层模式下不生效。详见 /v1/images/generations 说明。",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "可选",
              custom: true,
              description:
                "本站扩展：审核改写重试开关。false 时审核失败直接返回真实错误，不自动改写提示词重试。",
            },
            {
              name: "thinking",
              requirement: "可选",
              custom: true,
              description: "minimal、none、low、medium、high、xhigh。",
            },
            {
              name: "response_format",
              requirement: "可选",
              description:
                "url 或 b64_json。Agent 接口默认 url，避免多轮结果响应过大。",
            },
            {
              name: "stream",
              requirement: "可选",
              description:
                "true 或 Accept: text/event-stream 返回 SSE；同时要求 externalApi.streaming 能力。",
            },
          ],
          responses: [
            {
              name: "object / generation_id / model / size",
              description: "Agent 运行对象、生成记录和模型尺寸信息。",
            },
            {
              name: "data[]",
              description:
                "本次 Agent 产生的图片。output_role 可为 agent_draft 或 final；最后的 final 是默认成品。",
            },
            {
              name: "agent_events[]",
              description:
                "任务事件数组，包含联网、生图、继续/停止决策等结构化事件。",
            },
            {
              name: "credits_consumed",
              description:
                "本站结算积分。Agent 接口固定走 Codex/Responses 能力；当前轮次基础费用为 0，完成图片按最终图片固定价和运行时审核费结算，图片费用不乘分组倍率。",
              custom: true,
            },
            {
              name: "agent_round_count",
              description: "本次 Agent 任务的执行轮数。",
              custom: true,
            },
            {
              name: "SSE agent.event / agent.text_delta / agent.thinking_delta / agent.delta / agent.partial_image / agent.completed / agent.failed",
              description: "流式 Agent 任务事件、流式预览图和最终完成事件。",
            },
          ],
          notes: [
            "该接口是本站扩展，不是 OpenAI 官方接口；/api/v1/agents/images 是同一 handler 的别名。",
            "需要启用 externalApi.agent 系统能力；管理员可在系统设置中调整。",
            "该接口强制 requiresResponsesBackend，不会命中 Web 账号；支持 Codex/Responses 账号或支持 /responses 的外接 API 后端。",
            "不会调用页面 /api/images/chat；它和页面 Agent 共享 runImageGenerationForUser service 层。",
          ],
        },
        {
          title: "Create response",
          method: "POST",
          path: "/v1/responses",
          contentType: "application/json",
          description:
            "基于 OpenAI Responses API 的生图适配入口。它会按 responses 调度类型选择 Codex/Responses 账号池或外接 /responses API 后端。",
          example: `# 1. 最小 Responses 生图请求；需要 API Key、可用分组和足够积分
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "生成一张 1:1 的未来感产品渲染图",
    "size": "1024x1024",
    "quality": "high",
    "moderation": "auto"
  }'

# 2. 显式 image_generation tool，并指定图片模型
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "生成一张横版科技产品 KV",
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1536x864",
    "quality": "medium",
    "reasoning": { "effort": "low" },
    "store": true
  }'

# 3. 带参考图的 Responses 输入
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "参考这张图，换成冬季海报风格" },
          { "type": "input_image", "image_url": "https://example.com/reference.png" }
        ]
      }
    ],
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1024x1024",
    "output_format": "webp",
    "output_compression": 85,
    "moderation": "low"
  }'

# 4. 续接上一轮，并使用流式返回
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "previous_response_id": "resp_previous_id",
    "input": "在上一张图基础上加一个月亮",
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1024x1024",
    "reasoning": { "effort": "minimal" },
    "stream": true
  }'`,
          responseExample: `{
  "id": "resp_...",
  "object": "response",
  "created_at": 1713833628,
  "status": "completed",
  "model": "gpt-5.4",
  "output": [
    {
      "id": "ig_...",
      "type": "image_generation_call",
      "status": "completed",
      "result": "..."
    }
  ],
  "usage": null,
  "metadata": {
    "generation_id": "...",
    "credits_consumed": 1.31,
    "size": "1024x1024"
  }
}

# stream=true 时的 SSE 片段
event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"ig_...","type":"image_generation_call","status":"completed","result":"..."}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_...","object":"response","created_at":1713833628,"status":"completed","model":"gpt-5.4","output":[{"id":"ig_...","type":"image_generation_call","status":"completed","result":"..."}],"usage":null,"metadata":{"generation_id":"...","credits_consumed":1.31,"size":"1024x1024"}}}
`,
          fields: [
            {
              name: "model",
              requirement: "可选",
              description:
                "Responses 顶层模型。可用模型以 /v1/models 返回和 API Key 绑定分组为准。",
            },
            {
              name: "input",
              requirement: "必填",
              description:
                "字符串，或消息数组。消息 content 支持字符串、input_text/output_text，以及 input_image.image_url。",
            },
            {
              name: "previous_response_id",
              requirement: "可选",
              description:
                "续接上一轮 response。本站会读取内部保存的 webConversation/fallbackHistory 延续上下文。",
            },
            {
              name: "tools",
              requirement: "可选",
              description:
                '若显式传入，必须包含 { type: "image_generation" }；未传时本站会自动补 image_generation。图片模型请放在 image_generation tool 的 model 字段。',
            },
            {
              name: "tool_choice",
              requirement: "可选",
              description:
                "兼容接收字段。对话/多工具场景不建议强制指定，否则模型可能无法同时使用联网、代码解释器或图片生成工具。",
            },
            {
              name: "stream",
              requirement: "可选",
              description: "true 时返回 Responses 风格 SSE 事件。",
            },
            {
              name: "store",
              requirement: "可选",
              description:
                "兼容接收字段；本站内部会自行保存必要续聊状态，不保证按官方 store 语义透传。",
            },
            {
              name: "reasoning.effort",
              requirement: "可选",
              description:
                "支持 minimal、none、low、medium、high、xhigh；最终是否生效取决于命中的后端。",
            },
            {
              name: "size",
              requirement: "可选",
              custom: true,
              description:
                "本站便捷字段：未在 image_generation tool 内指定尺寸时，作为本次生图 size 使用。",
            },
            {
              name: "quality",
              requirement: "可选",
              custom: true,
              description: "本站便捷字段：作为本次生图 quality 运行参数使用。",
            },
            {
              name: "moderation",
              requirement: "可选",
              custom: true,
              description:
                "本站便捷字段：作为本次生图的上游 moderation 参数使用，不会修改平台集中管理的内容审核级别。",
            },
            {
              name: "output_format",
              requirement: "可选",
              custom: true,
              description:
                "本站便捷字段：未在 image_generation tool 内指定输出格式时，作为本次 output_format 使用。也可直接写在 image_generation tool 里。",
            },
            {
              name: "output_compression",
              requirement: "可选",
              custom: true,
              description:
                "本站便捷字段：未在 image_generation tool 内指定压缩率时，作为本次 output_compression 使用。",
            },
            {
              name: "background",
              requirement: "可选",
              description:
                "transparent、opaque、auto，作为本次生图 background。详见 /v1/images/generations 说明。",
            },
            {
              name: "transparent_matte",
              requirement: "可选",
              custom: true,
              description:
                "默认 false。仅当 background=transparent 且设为 true 时：命中的后端不支持透明返回 400 后自动改不透明重绘，再用 ISNet 抠图得到透明 PNG；agent 分层模式下不生效。详见 /v1/images/generations 说明。",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "可选",
              custom: true,
              description:
                "本站便捷字段：审核改写重试开关。false 时审核失败直接返回真实错误，不自动改写提示词重试。",
            },
          ],
          responses: [
            {
              name: "id / object / created_at / status / model / output",
              description: "兼容 Responses response 对象的基本结构。",
            },
            {
              name: "output[].type = image_generation_call",
              description: "图片结果放在 result 字段，值为 b64_json。",
            },
            {
              name: "output[].type = message",
              description: "若上游返回文本，会以 output_text 返回。",
            },
            {
              name: "metadata.generation_id / credits_consumed / size",
              description: "本站生成记录、结算积分和尺寸信息。",
              custom: true,
            },
            {
              name: "SSE response.output_item.done / response.completed",
              description: "流式输出项完成和整体完成事件。",
            },
            {
              name: "SSE response.output_text.delta / response.reasoning_summary_text.delta",
              description: "文本和思考摘要增量事件。",
            },
          ],
          notes: [
            "该接口需要有效 API Key、可用分组和足够账户积分。",
            "该接口不是 Chat Completions；普通对话生图请使用 /v1/chat/completions，Responses 工具语义请使用本接口。",
            "input_image 只支持 image_url/data URL；file_id/file 输入当前不会作为参考图使用。",
            "显式传 tools 但不包含 image_generation 会返回错误，避免模型只产出文本而不生图。",
            "页面 Chat 模式只提供普通多模态对话/生图语义；Agent 模式默认提供 image_generation、web_search 和线性续跑工具 continue_generation，不强制 tool_choice，模型按任务自行选择工具。",
            "页面 Chat/Agent 支持上传文本/代码类本地文件作为上下文读取；不会读取用户在提示词中写入的服务器本地路径。",
            "页面 Chat/Agent 当前轮次基础费用为 0；完成图片按实际尺寸与数量及审核成本扣除积分。",
            "Agent 会把上一轮文字、工具结果和已生成图片喂回下一轮，让模型自行判断是否继续改版；最大轮数由系统设置 IMAGE_AGENT_MAX_ROUNDS 控制，默认 3。",
            "Agent 多轮产生的 image_generation_call 会作为自动迭代版本展示，最后一张作为默认选中版本。",
          ],
        },
      ],
    },
    web: {
      title: "Web 账号",
      description:
        "走 ChatGPT 网页生图能力，适合复用 Web 账号额度，但不是严格参数化的 Images/Responses API。",
      valid: [
        "**分辨率不可严格控制；size 只能作为提示/记录参考，不能保证按请求尺寸输出。**",
        "**不能保证 4K 输出；是否出高分辨率取决于 ChatGPT Web 当前能力和账号状态。**",
        "可控制主 GPT 对话模型和 Web 思考强度；图片模型字段不会映射成独立 Web 生图模型。",
        "关闭提示词优化时会发送原始 prompt，并把 Web 思考强度压到 instant，尽量减少平台侧改写。",
      ],
      invalid: [
        "外部 /v1/responses 会适配进统一 chat 生成链路，但调度类型仍是 responses；当前只会选择 Codex/Responses 分组或外接 Responses API 后端，不会转到 Web 账号池。",
        "外部 /v1/responses 的 model 为空时使用后端默认；显式传入时需在 /v1/models 返回列表内，超出列表会被本站拦截。",
        "不保证完全不改写提示词；ChatGPT Web 上游仍可能理解、补全或改写。",
      ],
    },
    codex: {
      title: "Codex / Responses 账号",
      description: "走 Responses 语义，是本站可参数化程度最高的系统账号后端。",
      valid: [
        "GPT 模型传给 Responses 顶层 model。",
        "图片模型传给 image_generation 工具 model。",
        "size、quality、moderation、参考图、mask 会组装进 Responses 工具请求。",
        "页面 Chat 模式只提供普通多模态对话/生图语义；页面 Agent 模式默认提供 image_generation、web_search、continue_generation，不强制 tool_choice，并会线性多轮续跑，让模型像 Codex 一样按需联网、读取已上传文本文件上下文、生成草图和迭代改版。",
        "Chat/Agent 上传的本地文本/代码文件会作为请求上下文读取；不会开放服务器文件系统路径读取。",
        "支持外部 /v1/responses；也可承接 /v1/images/generations 和 /v1/images/edits 的内部转换。",
        "关闭提示词优化时，会通过指令引导模型不要修改提示词；这是尽力约束，不能保证上游一定完全照做。",
        "页面 Chat/Agent 当前轮次基础费用为 0；完成图片按实际尺寸与数量及审核成本扣除积分。",
      ],
      invalid: [
        "不是 ChatGPT Web，不支持 Web 专属能力或 Web 额度语义。",
        "账号限流、额度不足、凭据失效时，调度器会冷却/标错并尝试轮换。",
      ],
    },
    adobe: {
      title: "Adobe（Firefly）账号",
      description:
        "直连 Adobe Firefly 的自管账号/token 池，作为特殊成员按 priority 挂入分组兜底。",
      valid: [
        "**分辨率只接受 1k / 2k / 4k 三档，不是任意像素分辨率；传入的 size 会被映射到最近的比例（1x1/16x9/9x16/4x3/3x4）与最近的档位（长边 ≤1024→1k、≤2048→2k、否则 4k）。**",
        "只有当前分组 Adobe 成员 supportedModelIds 显式暴露的真实模型 ID 才能调度到该成员；客户端前缀和别名不参与路由。",
        "自管账号/token 池，作为特殊成员按 priority 挂入分组兜底。",
      ],
      invalid: [
        "不支持的参数会被静默忽略，不报错。",
        "无法严格按任意像素尺寸输出；只能落到 1k/2k/4k 三档之一。",
      ],
    },
    api: {
      title: "外接 API 后端",
      description:
        "走管理员配置的 OpenAI 兼容 Base URL/API Key，最终能力由对方服务决定。",
      valid: [
        "接口模式只声明上游支持哪些端点：仅 Images 只参与文生图/图生图；仅 Responses 只参与 Chat/Agent/Responses，除非 Images 上游开关设为 Responses；混合 API 两边都可参与。",
        "Images 上游开关独立控制文生图/图生图：原生 Images 会请求对方 /images/generations 和 /images/edits；转换为 Responses 会请求对方 /responses + image_generation tool。",
        "Chat Completions 上游开关独立控制 /v1/chat/completions：Responses 生图模式请求对方 /responses；原生模式请求对方 /chat/completions。",
        "模型、尺寸、质量、流式事件、usage 字段是否支持，以对方接口为准。",
      ],
      invalid: [
        "不使用本站 Web 或 Codex 账号池额度。",
        "对方如果自行改写提示词或限制分辨率，本站无法覆盖。",
      ],
    },
    prompt: {
      title: "提示词优化与思考强度",
      rows: [
        [
          "开启提示词优化",
          "平台可使用优化后的提示词，Web 思考强度按选择值传入。",
        ],
        [
          "关闭提示词优化",
          "平台发送原始提示词，Web 强制使用 instant，尽量减少改写。",
        ],
        [
          "Codex/Responses",
          "关闭提示词优化时通过指令要求模型不要修改提示词，但具体是否改写仍由上游模型和工具决定。",
        ],
        ["外接 API", "平台尽量透传，最终行为取决于外接服务。"],
      ],
    },
    postProcess: {
      title: "分辨率超分与高清修复",
      rows: [
        [
          "超分（自动）",
          "Web / Codex 等后端常返回小于请求尺寸的图（Codex 尤其不严格遵循 size）。平台会在最终图较长边不足目标尺寸 2/3 时，用 Real-ESRGAN 自动放大到目标尺寸（不裁剪、保宽高比），因此 Web / Codex 也能稳定输出接近 4K 的目标分辨率——即「支持 4K」。由管理端「出图分辨率超分校准」开关控制，单张约 1-2 秒。",
        ],
        [
          "高清修复（手动）",
          "与超分相互独立。用户在创作页勾选「高清修复」或 API 传 hd_repair=true 时，对最终图用 SCUNet 做盲复原（去噪 / 去压缩块 / 增强质感，不改分辨率）。CPU 推理较重（512 约 11 秒、1024 约 35 秒）、服务端全局串行排队，出图更慢；由管理端「出图高清修复(SCUNet)」开关控制，需用户手动勾选，默认关。",
        ],
        [
          "生成式修复（手动，gpt-image-2）",
          "与高清修复不同：它用真实生成后端重绘。用户勾选「生成式修复」或 API 传 block_repair=true 时，把最终图缩到 web 甜点分辨率（约 1280），一次性用 gpt-image-2 img2img 整图重绘（重点修文字/细节、保持构图与内容不变，提示词取 repair_prompt 或内置默认），再超分补足到目标尺寸。整图一次重绘无接缝（不再切块，避免重叠重影）；额外调用一次后端并单独计费，比超分/高清修复更慢也更贵；由管理端「出图生成式修复」开关控制，需手动勾选，默认关。启用成功时替代自动超分。",
        ],
        [
          "组合与顺序",
          "超分与高清修复可叠加：先修复（原分辨率，省算力）再超分（放大到目标）。生成式修复启用时自带超分到目标、替代自动超分。都不裁剪、不改宽高比；任一步失败自动回退原图，不阻断出图。",
        ],
      ],
    },
    roadmap: {
      title: "后续规划",
      items: [
        "Sub2API 非数据库接口：当前同步依赖 SUB2API_POSTGRES_URL 直连 Sub2API PostgreSQL。后续调研并适配 Sub2API 管理员 Key / HTTP API 路线，优先用正式接口完成账号查询、分组筛选、状态读取、错误清理和同步任务；只有接口缺字段或能力不足时再保留数据库直连兜底。",
        "PSD 生成接口：准备适配 PSD/分层文件生成能力，需先明确上游接口协议、输出 MIME/扩展名、存储与预览策略、积分计费、外接 API 响应字段、后台能力矩阵开关和页面下载入口。",
        "图片引用交互：继续完善 @图1、@第N轮图M 的原子化输入、图片重排后的引用重映射和缺失引用提示。",
        "Agent 分支对话/轮次树：编辑或重生成历史某一轮时，从该轮派生新分支，避免覆盖后续记录。",
      ],
    },
  },
  en: {
    title: "System Docs",
    subtitle:
      "Page endpoints and external endpoints are protocol adapters. They do not call each other over HTTP; they enter the same generation, billing, scheduling, and storage path. Default deployments enable self-use mode: public registration is closed and the first startup creates a super admin from environment credentials.",
    flow: {
      title: "Request Routing Diagram",
      note: "All image/chat/responses requests use the platform backend pool and settle through platform credits. External endpoints do not call internal /api/images/* routes.",
      entryTitle: "Entry",
      resolverTitle: "Unified Handler",
      groupTitle: "Group Selection",
      backendTitle: "Backend Target",
      entries: [
        {
          label: "Page text-to-image",
          path: "POST /api/images/generate",
          kind: "image_generation",
        },
        {
          label: "Page image edit",
          path: "POST /api/images/edit",
          kind: "image_edit",
        },
        {
          label: "Page image chat",
          path: "POST /api/images/chat",
          kind: "chat",
        },
        {
          label: "Page Agent image run",
          path: "POST /api/images/chat",
          kind: "agent",
        },
        {
          label: "External image API",
          path: "POST /v1/images/generations",
          kind: "image_generation",
        },
        {
          label: "External edit API",
          path: "POST /v1/images/edits",
          kind: "image_edit",
        },
        {
          label: "External video API",
          path: "POST /v1/videos",
          kind: "video",
        },
        {
          label: "External async image task",
          path: "GET /v1/images/{task_id}",
          kind: "image_generation",
        },
        {
          label: "External video task",
          path: "GET /v1/videos/{id}",
          kind: "video",
        },
        {
          label: "External Chat Completions API",
          path: "POST /v1/chat/completions",
          kind: "chat",
        },
        {
          label: "External Responses API",
          path: "POST /v1/responses",
          kind: "responses",
        },
        {
          label: "External Agent image API",
          path: "POST /v1/agents/images",
          kind: "agent",
        },
      ],
      resolver: [
        "Validate session or API key",
        "Convert page forms or OpenAI-compatible requests into unified run parameters",
        "Calculate credits and moderation cost",
        "Call runImageGenerationForUser for the shared generation path",
      ],
      groups: [
        "API key bound group first",
        "Unbound API keys use the platform default group",
        "Page creation can use an authorized backend group selected for the current request",
        "Group checks enabled state, content-safety setting, explicit models, and queue priority",
      ],
      backends: [
        {
          title: "Web Account Pool",
          description:
            "Uses the ChatGPT Web path for page generation, edit, and image chat.",
        },
        {
          title: "Codex/Responses Pool",
          description:
            "chat / agent / responses use Responses semantics (image_generation tool loop, multi-round). Plain image generation and image edits instead route to that account's direct /images/generations and /images/edits endpoints (same OAuth credential, JSON body, size at the top level; image-to-image input/mask passed as base64 data URLs in images[].image_url / mask.image_url) to deterministically honor size — the Codex-hosted image_generation tool ignores size, so plain generation/edit no longer uses it (the codex images endpoints take JSON, not multipart). Even when the upstream returns a smaller image, the final image is auto-upscaled to the target resolution (see 'Super-Resolution And HD Repair' below), so Web/Codex output likewise supports near-4K target sizes.",
        },
        {
          title: "Adobe (Firefly) Pool",
          description:
            "Participates as a normal group member ordered by priority. The member must explicitly expose the exact requested model ID in supportedModelIds. Client prefixes and aliases do not select a member; only the selected member's adapter translates the upstream protocol.",
        },
        {
          title: "External API Backend",
          description:
            "Admin-configured OpenAI-compatible Base URL/API Key; calls images or responses endpoints by request type.",
        },
      ],
    },
    routeTables: {
      title: "Entry To Backend Mapping",
      pageTitle: "Page Requests",
      apiTitle: "External API Requests",
      headers: [
        "Entry",
        "Internal Endpoint",
        "Request Kind",
        "Backend Behavior",
      ],
      apiHeaders: [
        "Entry",
        "Compatible Endpoint",
        "Request Kind",
        "Backend Behavior",
      ],
      pageRows: [
        [
          "Create page generation",
          "/api/images/generate",
          "image_generation",
          "Routes through the selected platform backend group to a Web account, Codex/Responses account, or external API backend.",
        ],
        [
          "Create page edit",
          "/api/images/edit",
          "image_edit",
          "Reference images enter the internal endpoint first, then route through the selected backend group.",
        ],
        [
          "Create page image chat",
          "/api/images/chat",
          "chat",
          "Uses chat routing; can select Web accounts, Codex/Responses accounts, or external API backends that support /responses.",
        ],
        [
          "Create page Agent run",
          "/api/images/chat",
          "agent",
          "Same internal endpoint, but uses Codex/Responses capability; it provides image_generation, web_search, continue_generation, and visible task cards.",
        ],
      ],
      apiRows: [
        [
          "OpenAI images generation",
          "/v1/images/generations",
          "image_generation",
          "Validates the API key, bound group, and account credits, then enters the same generation path; b64_json is the default response format, url can be requested explicitly.",
        ],
        [
          "OpenAI images edit",
          "/v1/images/edits",
          "image_edit",
          "Multipart images are converted into unified image inputs before backend routing.",
        ],
        [
          "OpenAI-style video",
          "/v1/videos",
          "video",
          "FluxMedia extension. Always creates a persistent video task and returns HTTP 202. Poll GET /v1/videos/{id} with the returned task ID, or configure callback_url for terminal delivery.",
        ],
        [
          "Async image task",
          "/v1/images/{task_id}",
          "image_generation",
          "Returns the in-memory task created with async=true. Tasks expire after 30 minutes.",
        ],
        [
          "Video task",
          "/v1/videos/{id}",
          "video",
          "Looks up status, input summary, and the completed output URL by the persistent video task ID returned by the create endpoint.",
        ],
        [
          "OpenAI chat completions",
          "/v1/chat/completions",
          "chat",
          "Checks externalApi.chat.completions and then enters the page Chat non-Agent path; can route to Web, Codex/Responses, or external API backends that support /responses.",
        ],
        [
          "OpenAI Responses",
          "/v1/responses",
          "responses",
          "Adds the image_generation tool when tools are omitted; explicit tools must include image_generation. Responses routing selects Codex/Responses groups or external /responses API backends.",
        ],
        [
          "FluxMedia Agent image run",
          "/v1/agents/images",
          "agent",
          "FluxMedia extension. Requires externalApi.agent, routes to Codex/Responses only, and can stream Agent task events plus multi-round image outputs.",
        ],
        [
          "OpenAI models",
          "/v1/models",
          "-",
          "Only lists models exposed by the API key's bound group and enabled members; it does not trigger backend pool routing.",
        ],
        [
          "FluxMedia credits",
          "/v1/credits",
          "-",
          "Returns the current API key quota, usage, remaining quota, and the owning account credit balance without backend routing.",
        ],
      ],
    },
    relationship: {
      title: "How The Page And External Endpoints Relate",
      rows: [
        [
          "Three page endpoints",
          "/api/images/generate, /api/images/edit, /api/images/chat",
          "Browser-session entrypoints that adapt page forms, reference images, and internal stream events.",
        ],
        [
          "Agent mode",
          "/api/images/chat + agentMode=true",
          "Enables a Codex-style tool loop and automatic image iteration inside the page Chat endpoint.",
        ],
        [
          "External API entries",
          "/v1/chat/completions, /v1/images/generations, /v1/images/edits, /v1/videos, /v1/images/{task_id}, /v1/responses, /v1/agents/images",
          "/api/v1/* is an alias to the same handlers; these adapt API keys and OpenAI-compatible request/response formats.",
        ],
        [
          "Shared core",
          "runImageGenerationForUser",
          "Credits, moderation, queueing, backend pool selection, error marking, cooldowns, refunds, and storage live here.",
        ],
        [
          "Backend execution",
          "generateImage / editImage / generateChatImage",
          "The selected member is converted to a ChatGPT Web, Codex/Responses, or external API request.",
        ],
      ],
      note: "The relationship is not external API -> page API. It is multiple adapters -> one shared service layer.",
    },
    moderationRepair: {
      title: "Safety Prompt Repair Retry",
      description:
        "When local moderation, upstream safety refusal, or safety-refusal text without an image is detected, the system can rewrite the prompt through a text-only Responses request and retry generation inside the same task.",
      valid: [
        "Requires at least one usable Codex/Responses account or an external API backend that supports /responses. Even a Web-only generation group can borrow a Responses backend for the rewrite step.",
        "IMAGE_MODERATION_PROMPT_REPAIR_ENABLED controls the feature; IMAGE_MODERATION_PROMPT_REPAIR_MAX_RETRIES controls the maximum rewrite rounds. Set retries to 0 to disable.",
        "Retries do not create a second generation record. Billing remains attached to the original task and final output; the status page reports attempts, successes, and failures by retry number.",
        "When a rewrite succeeds, the UI and external API return a separate notice that the original prompt was rejected by safety checks and generated after additional adjustments. This notice is not written into revised_prompt.",
        "If no Responses backend is available, or the rewritten prompt is still blocked, the original moderation failure is kept and normal failed-settlement rules apply.",
      ],
      invalid: [
        "Moderation-service outages, upstream rate limits, insufficient credits, and model permission errors are not prompt-repair cases.",
        "Only the text prompt is rewritten; uploaded reference images, masks, and attachments are not modified.",
      ],
    },
    agent: {
      title: "Page Agent Mode",
      description:
        "Agent is a Codex-style automatic run mode. The page version reuses /api/images/chat and shows task cards; /v1/agents/images exposes the same run style as JSON/SSE for external clients.",
      valid: [
        "Enabled only when Codex/Responses capability is available; the Web branch does not run Agent tools.",
        "Default tools include image_generation, web_search, and continue_generation. The backend does not force tool_choice so the model can combine search, image generation, and continuation.",
        "Each round shows Agent task cards such as web search, tool compatibility adjustment, image generation, streaming preview, and continue/stop decisions.",
        "Uploaded text/code files can be read as request context; prompted server filesystem paths are not read.",
        "Max rounds are configurable. With force rounds enabled, Agent runs the selected number of rounds; otherwise the model decides whether to continue through continue_generation.",
        "Draft images from multiple rounds are stored as iteration variants, with the last image selected as the default final output.",
        "The current Chat/Agent base round charge is 0; completed images are billed by actual output and moderation cost.",
      ],
      invalid: [
        "External /v1/responses is not Agent. It adapts the OpenAI Responses protocol and does not automatically enable the Agent tool loop.",
      ],
    },
    externalDocs: {
      title: "External API Reference",
      subtitle:
        "This documents the currently supported OpenAI-compatible surface. Bold fields are FluxMedia extensions or compatibility additions, not standard OpenAI fields.",
      commonTitle: "Common Rules",
      baseUrlTitle: "Base URL",
      examplesTitle: "Request Example",
      responseExampleTitle: "Response Example",
      copyLabel: "Copy",
      copiedLabel: "Copied",
      copyFailedLabel: "Copy failed",
      common: [
        "All external endpoints require Authorization: Bearer <FluxMedia API key>.",
        "Chat Completions, image, video, Responses, and Agent requests validate the API key, bound group, and account credits; availability is controlled by group members and system switches, with usage billed consistently.",
        "/api/v1/* and /v1/* use the same handlers; they are path aliases.",
        "All API key requests use the normal persistence path and write generation history, object storage, usage records, and continuation state as supported by each endpoint. There is no no-record mode.",
        "Platform content-moderation levels are centrally managed by administrators: a user override wins, otherwise the global default applies, and missing or invalid values fall back to high. Callers cannot change this policy through an API key or request field. low, medium, and high only change Aliyun thresholds; the OpenAI moderation provider is unchanged by these levels.",
        "response_format controls URL vs base64; output_format controls the image file format. They are different fields.",
        "Error responses use an OpenAI-style error object. FluxMedia may also return generation_id, generationId, and credits_consumed for debugging and reconciliation.",
        "A backend group bound to the API key wins first. Otherwise the platform default group is used, then the enabled fallback group. Page creation can select an authorized group for the current request.",
        "Images use fixed 1024, 1K, 2K, and 4K tiers selected from actual output pixels. Pricing resolves the selected group's model override, then the required global model price, and finally adds runtime review fees. Videos resolve each model family's per-second price from the group override and then the required global price. Neither path uses group multipliers.",
        "API keys can have independent credit limits. GET /v1/credits returns key quota, used credits, and account balance.",
        "All page and external API requests use the platform backend pool and settle through platform credits and API key quotas.",
        "Image endpoint web_first / webFirst / force_web / forceWeb (chat: mix_web_first) is a Web-first preference route, not hard Web-only, and is on by default. When on (omitted or explicit true) it uses the Web-first pixel range (IMAGE_FORCE_WEB_MIN_PIXELS / IMAGE_FORCE_WEB_MAX_PIXELS, default 0.66MP-2MP): only sizes inside the range prefer Web (fall back to Codex/Responses on failure), sizes outside (e.g. 4K) use normal scheduling, auto or unparseable sizes may prefer Web; explicit false disables it. It only applies to mixed backend groups (no effect for Web-only / Codex-Responses-only groups); agent always uses Codex/Responses and is unaffected.",
        "Adobe (Firefly) and API backends follow the same group scheduling rule: only exact model IDs explicitly declared in member supportedModelIds are candidates. Client model IDs are not rewritten from vendor prefixes or aliases. Images use fixed model-tier prices plus runtime review fees, while videos use fixed model-family prices per second.",
        "Image async tasks: body async:true or URL ?async=true (equivalent, and cannot be combined with stream) returns a task_... object immediately; poll GET /v1/images/{task_id}. These process-local tasks expire after 30 minutes. Use the generation_id from an image response for persistent image lookups, and callback_url for image completion delivery. Video uses a separate persistent-task contract: POST /v1/videos always returns HTTP 202 and a video task ID, then GET /v1/videos/{id} polls it. The async body field is accepted only for compatibility and does not change behavior; URL ?async is not a supported video mode switch. callback_url is attached to the persistent video task and delivered at terminal state.",
      ],
      officialRefsTitle: "Official References",
      officialRefs: [
        {
          label: "Chat Completions API",
          href: "https://developers.openai.com/api/reference/chat/create",
        },
        {
          label: "Images API",
          href: "https://developers.openai.com/api/reference/resources/images",
        },
        {
          label: "Responses API",
          href: "https://developers.openai.com/api/reference/resources/responses/methods/create",
        },
        {
          label: "Models API",
          href: "https://developers.openai.com/api/reference/resources/models/methods/list",
        },
        {
          label: "Adobe routing and fallback scheduling",
          href: "/docs/adobe-firefly-routing",
        },
        {
          label: "Adobe compatibility conversion",
          href: "/docs/adobe-firefly-compat",
        },
      ],
      fieldHeaders: ["Field", "Requirement", "Notes"],
      responseHeaders: ["Response field", "Notes"],
      requestTitle: "Request Fields",
      responseTitle: "Response And Streaming",
      notesTitle: "Implementation Notes",
      customLabel: "Extension",
      docs: [
        {
          title: "List models",
          method: "GET",
          path: "/v1/models",
          contentType: "No request body",
          description:
            "Compatible with OpenAI List models. Lists image, Responses, and real video model IDs exposed by the current API key's bound group and enabled members, plus model IDs configured on enabled API providers.",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/models \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "list",
  "data": [
    {
      "id": "gpt-image-2",
      "object": "model",
      "created": 0,
      "owned_by": "gpt2image"
    }
  ]
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "Required header",
              description: "Bearer <FluxMedia API key>.",
            },
          ],
          responses: [
            {
              name: "object",
              description: "Always list.",
            },
            {
              name: "data[].id",
              description:
                "Model ID. Includes the default image model, Adobe Firefly image-family IDs, real video model IDs, available Chat/Responses models, and model IDs configured on enabled API providers.",
            },
            {
              name: "data[].object / created / owned_by",
              description: "Compatible with the OpenAI model object shape.",
            },
          ],
          notes: [
            "Only model listing is implemented; /v1/models/{model} is not implemented.",
            "Returned models are filtered by the API key's bound group, enabled members' explicit model lists, and system capability switches; the list can be empty when no reachable member is configured.",
            "A non-empty API provider supported-model list also restricts that provider's scheduler eligibility. Legacy providers with an empty list stay unrestricted and only contribute their default model to the list.",
          ],
        },
        {
          title: "Get credits",
          method: "GET",
          path: "/v1/credits",
          contentType: "No request body",
          description:
            "Returns the current Bearer API key's credit limit, used credits, remaining credits, and owning account balance.",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/credits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "credit_balance",
  "account": {
    "balance": 15702.45,
    "total_earned": 20000,
    "total_spent": 4297.55,
    "status": "active"
  },
  "api_key": {
    "credit_limit": 1000,
    "credits_used": 12.7,
    "credits_remaining": 987.3,
    "unlimited": false
  }
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "Required header",
              description: "Bearer <FluxMedia API key>.",
            },
          ],
          responses: [
            {
              name: "account.balance",
              description: "Current available credits on the owning account.",
            },
            {
              name: "account.total_earned / total_spent / status",
              description:
                "Cumulative credits earned / spent, and account status (active / frozen).",
            },
            {
              name: "api_key.credit_limit",
              description:
                "Total limit for this API key; null means unlimited.",
            },
            {
              name: "api_key.credits_used / credits_remaining",
              description:
                "Used and remaining quota for this key. credits_remaining is null when unlimited.",
            },
          ],
          notes: [
            "The API key quota only limits this key. Calls through the FluxMedia-billed platform path still require enough account credits.",
            "Failed-generation refunds, moderation settlement, and actual-size corrections also update key usage.",
            "The api_key object also includes id / name / key_prefix / last_four / is_active / last_used_at / created_at (omitted from the example).",
          ],
        },
        {
          title: "Create chat completion",
          method: "POST",
          path: "/v1/chat/completions",
          contentType: "application/json",
          description:
            "OpenAI-compatible Chat Completions adapter for FluxMedia page Chat non-Agent mode. It does not enable the Agent tool loop.",
          example: `# 1. Chat-to-image. URL is the default to keep response bodies small.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "messages": [
      { "role": "system", "content": "You are a professional poster designer." },
      { "role": "user", "content": "Create a 16:9 blue and white technology company poster" }
    ],
    "size": "1536x864",
    "quality": "high",
    "response_format": "url"
  }'

# 2. Multimodal input. image_url becomes a real reference image input for this turn.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "image_model": "gpt-image-2",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "Use this product photo to create an ecommerce hero image" },
          { "type": "image_url", "image_url": { "url": "https://example.com/product.png" } }
        ]
      }
    ],
    "size": "1024x1024",
    "response_format": "url"
  }'

# 3. Streaming. Text uses chat.completion.chunk; partial images use a FluxMedia extension event.
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/chat/completions \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "messages": [
      { "role": "user", "content": "Create a futuristic city concept image" }
    ],
    "size": "1024x1024",
    "stream": true
  }'`,
          responseExample: `{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1713833628,
  "model": "gpt-5.4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Image generated.\\n\\n![generated image 1](${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...)",
        "images": [
          {
            "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
            "revised_prompt": "...",
            "generation_id": "gen_..."
          }
        ]
      },
      "finish_reason": "stop"
    }
  ],
  "images": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "generation_id": "gen_..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 2.31,
  "usage": null
}

# stream=true SSE sample
data: {"id":"chatcmpl_...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Generating..."},"finish_reason":null}]}

event: chat.completion.partial_image
data: {"type":"chat.completion.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

data: {"id":"chatcmpl_...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"generation_id":"gen_...","credits_consumed":2.31}
`,
          fields: [
            {
              name: "messages",
              requirement: "Required",
              description:
                "OpenAI Chat Completions messages. The final user text becomes this turn's prompt; previous user/assistant messages become page Chat history; system/developer messages are merged into the system instruction (apiPrompt) and not counted as history.",
            },
            {
              name: "messages[].content[].image_url",
              requirement: "Optional",
              description:
                "Supports public http(s) image URLs or data:image URLs. Images in the final user message become real reference image inputs.",
            },
            {
              name: "model",
              requirement: "Optional",
              description:
                "GPT chat model. Web/Codex/Responses backends handle support according to their capabilities.",
            },
            {
              name: "size",
              requirement: "Optional",
              description:
                "Target size; invalid values are rejected. Used as a runtime Chat image parameter.",
            },
            {
              name: "quality",
              requirement: "Optional",
              description:
                "auto, low, medium, or high. Used as a runtime Chat image parameter.",
            },
            {
              name: "moderation",
              requirement: "Optional",
              description:
                "auto or low. Passed upstream as a runtime Chat image parameter; it does not change FluxMedia's centrally managed content-moderation level.",
            },
            {
              name: "stream",
              requirement: "Optional",
              description: "Returns text/event-stream when true.",
            },
            {
              name: "response_format",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension: url or b64_json. Defaults to url to avoid oversized Chat Completions payloads.",
            },
            {
              name: "image_model / imageModel",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension. Image model, must be gpt-image-*; Web backends do not map it to a separate Web image model.",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "Optional",
              custom: true,
              description: "Controls FluxMedia prompt optimization.",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension: safety prompt-repair retry toggle. When false, a moderation failure returns the real error directly instead of rewriting the prompt and retrying. Same meaning as /v1/images/generations.",
            },
            {
              name: "background",
              requirement: "Optional",
              description:
                "transparent, opaque, or auto. Same meaning as /v1/images/generations; applies to chat mode, without agent layering.",
            },
            {
              name: "transparent_matte",
              requirement: "Optional",
              custom: true,
              description:
                "Defaults to false. Only takes effect when background=transparent and explicitly set to true: if the selected backend rejects transparent with a 400, the request is regenerated opaque and matted server-side (ISNet) into a transparent PNG; not effective in the agent layered mode. See /v1/images/generations.",
            },
            {
              name: "thinking / reasoning.effort",
              requirement: "Optional",
              custom: true,
              description:
                "minimal, none, low, medium, high, xhigh. Mainly applies to Codex/Responses backends.",
            },
            {
              name: "mixWebFirst / mix_web_first",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension. In mixed groups, sizes inside the Web-first pixel range try Web first and fall back to Codex/Responses. The range is configured by IMAGE_FORCE_WEB_MIN_PIXELS / IMAGE_FORCE_WEB_MAX_PIXELS and defaults to 0.66MP-2MP.",
            },
            {
              name: "requiresResponsesBackend / requires_responses_backend",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension. Forces this Chat request to Codex/Responses capability instead of Web; when enabled it also bypasses the user's own connected API (like agent behavior) and settles FluxMedia credits via the platform / external backend pool.",
            },
          ],
          responses: [
            {
              name: "choices[].message.content",
              description:
                "OpenAI-style assistant text. URL image results are appended as Markdown image links.",
            },
            {
              name: "choices[].message.images / images",
              description:
                "FluxMedia extension. Structured image results with url or b64_json, generation_id, and revised_prompt.",
              custom: true,
            },
            {
              name: "generation_id / generationId",
              description:
                "FluxMedia extension. Non-stream success responses return this Chat round's generation record ID at the top level.",
              custom: true,
            },
            {
              name: "credits_consumed",
              description:
                "FluxMedia extension. FluxMedia-billed credits for this request. The current Chat base round charge is 0; completed images are billed by actual output and moderation cost.",
              custom: true,
            },
            {
              name: "SSE chat.completion.chunk",
              description: "OpenAI-style Chat Completions streaming chunk.",
            },
            {
              name: "SSE chat.completion.partial_image",
              description:
                "FluxMedia extension. Streaming image preview emitted during generation.",
              custom: true,
            },
          ],
          notes: [
            "Upstream API configs have two independent switches: Images upstream controls whether /v1/images/generations and /v1/images/edits call upstream /images/* or are converted to /responses + the image_generation tool; Chat Completions upstream only controls whether /v1/chat/completions calls upstream /chat/completions or /responses.",
            "Selecting chat_completions makes FluxMedia /v1/chat/completions call the selected upstream's /chat/completions. This is better for pure chat compatibility, but image output depends on the upstream implementation. Agent and /v1/responses are not affected.",
            "OpenAI official Chat Completions does not define a standard generated-image response field. FluxMedia extends the Chat Completions shape with choices[].message.images, top-level images, and Markdown image links in content. For strict official image-generation semantics, use /v1/images/generations, /v1/images/edits, or /v1/responses.",
            "This endpoint uses page Chat non-Agent mode. It does not inject web_search or continue_generation and does not return Agent task cards.",
            "The request kind is chat, so routing can select Web accounts, Codex/Responses accounts, or external API backends that support /responses. User custom upstream APIs still keep highest priority when available.",
            "Billing matches page Chat: the current Chat base round charge is 0; completed images use the model fixed price and runtime review fees. Image charges do not use group multipliers.",
          ],
        },
        {
          title: "Create image",
          method: "POST",
          path: "/v1/images/generations",
          contentType: "application/json",
          description:
            "Compatible with OpenAI Images generation. Requests become image_generation jobs in the shared generation path.",
          example: `# 1. Official Images-style request. b64_json is the default.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A cute baby sea otter",
    "size": "1024x1024",
    "quality": "medium",
    "moderation": "auto",
    "background": "auto"
  }'

# 2. Return a URL and disable FluxMedia prompt optimization.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-1.5",
    "prompt": "A cyberpunk city at night after rain, neon reflections",
    "size": "1024x1024",
    "quality": "high",
    "moderation": "low",
    "response_format": "url",
    "output_format": "webp",
    "output_compression": 85,
    "background": "transparent",
    "prompt_optimization": false
  }'

# 3. Codex/Responses backend-only parameters. Plain Images API backends may ignore them.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "Create a 16:9 product campaign poster",
    "size": "1536x864",
    "response_format": "url",
    "output_format": "jpeg",
    "output_compression": 90,
    "gptModel": "gpt-5.4",
    "thinking": "high",
    "promptOptimization": false
  }'

# 4. Prefer Web account scheduling for mixed groups within the configured pixel range. Failed or exhausted Web routing falls back to Codex/Responses.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A 1:1 avatar poster",
    "size": "1024x1024",
    "response_format": "url",
    "web_first": true
  }'

# 5. Streaming response. Accept: text/event-stream also enables streaming.
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A transparent glass futuristic coffee cup",
    "size": "1024x1024",
    "response_format": "url",
    "stream": true
  }'

# 6. Async mode. You may also append ?async=true. callback_url is optional.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-1.5",
    "prompt": "A transparent-background product icon",
    "size": "1024x1024",
    "response_format": "url",
    "output_format": "png",
    "background": "transparent",
    "async": true,
    "callback_url": "https://your-server.example/callback"
  }'

# 7. FluxMedia extensions: transparent background + ISNet matte fallback, with safety prompt-repair retry disabled.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/generations \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "A transparent-background product icon",
    "size": "1024x1024",
    "response_format": "url",
    "output_format": "png",
    "background": "transparent",
    "transparent_matte": true,
    "prompt_repair": false
  }'`,
          responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# SSE when stream=true
event: image_generation.partial_image
data: {"type":"image_generation.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: image_generation.completed
data: {"type":"image_generation.completed","index":0,"generation_id":"...","generationId":"...","model":"gpt-image-2","size":"1024x1024","credits_consumed":1.31,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","revised_prompt":"..."}]}

# Immediate async=true response
{
  "id": "task_...",
  "object": "image.generation",
  "model": "gpt-image-2",
  "status": "processing",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "generation_id": "gen_..."
}

# Poll task
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/task_... \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"

# Completed task response or callback payload
{
  "id": "task_...",
  "object": "image",
  "model": "gpt-image-2",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed": 1713833700,
  "completed_at": "2026-05-28T00:01:12.000Z",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}
`,
          fields: [
            {
              name: "prompt",
              requirement: "Required",
              description: "Image prompt, up to 32000 characters.",
            },
            {
              name: "model",
              requirement: "Required",
              description:
                "Exact image model ID returned by GET /v1/models for the current API key. The server matches only IDs explicitly exposed by members in the key's trusted group; it does not rewrite firefly-* prefixes, default, or other out-of-catalog aliases. Use /v1/responses for Responses chat models.",
            },
            {
              name: "size",
              requirement: "Optional",
              description:
                "Target size. Omission is equivalent to auto. FluxMedia validates the size and rejects invalid values.",
            },
            {
              name: "quality",
              requirement: "Optional",
              description: "auto, low, medium, or high.",
            },
            {
              name: "moderation",
              requirement: "Optional",
              description:
                "auto or low. Passed upstream as an image-generation parameter; it does not change FluxMedia's centrally managed content-moderation level.",
            },
            {
              name: "response_format",
              requirement: "Optional",
              description:
                "url or b64_json. Defaults to b64_json. url returns a FluxMedia storage URL.",
            },
            {
              name: "output_format",
              requirement: "Optional",
              description:
                "png, jpeg, or webp. Controls the actual output image format; upstream support may vary.",
            },
            {
              name: "output_compression",
              requirement: "Optional",
              description:
                "compression level 0-100, only meaningful for jpeg/webp; higher = more compression, smaller file, lower quality (OpenAI-native output_compression semantics, passed through).",
            },
            {
              name: "background",
              requirement: "Optional",
              description:
                "transparent, opaque, or auto. Transparent backgrounds require support from the selected upstream model and usually require png or webp output. Unsupported models may return a 400 error such as “Transparent background is not supported for this model”. To still get a transparent result on an unsupported backend, also pass transparent_matte=true (see next field). Use auto or opaque when support is unknown.",
            },
            {
              name: "transparent_matte",
              requirement: "Optional",
              custom: true,
              description:
                "Defaults to false. Only takes effect when background=transparent and explicitly set to true: if the selected backend rejects transparent with a 400, the request is regenerated opaque and matted server-side (ISNet) into a transparent PNG. When off, transparent is passed through and an unsupported backend returns the real 400 error. Applies to single image generation/edit/chat only, not the agent layered mode.",
            },
            {
              name: "stream",
              requirement: "Optional",
              description: "true returns text/event-stream.",
            },
            {
              name: "async",
              requirement: "Optional",
              custom: true,
              description:
                "Async switch. Set body async:true OR append ?async=true to the URL (the two are equivalent). When on, the endpoint returns a task_... object immediately (status:processing) and runs generation in the background; poll GET /v1/images/{task_id} for the result. Cannot be combined with stream (sending both returns async cannot be used with stream.).",
            },
            {
              name: "callback_url",
              requirement: "Optional",
              custom: true,
              description:
                "Completion-callback webhook (not a URL you poll). Async only: when the task completes or fails, the server POSTs the final task object to this URL with headers X-Tokens-Callback: true and Content-Type: application/json. The URL must be publicly reachable over http/https. An already-sent callback is unaffected even if the task later expires (30 min) or is lost on restart.",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "Optional",
              custom: true,
              description:
                "Controls whether FluxMedia may further optimize prompt. If prompt is already the final optimized prompt, pass false.",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "Optional",
              custom: true,
              description:
                'Safety prompt-repair retry toggle (issue #24). Defaults to the platform setting (usually enabled): when local moderation or an upstream safety refusal yields no image, the system rewrites the prompt through Responses and re-moderates and retries inside the same task. When explicitly false, this automatic rewrite-retry is disabled and a moderation failure returns the real error without rewriting the prompt. See "Safety Prompt Repair Retry" below.',
            },
            {
              name: "gptModel / gpt_model",
              requirement: "Optional",
              custom: true,
              description:
                "When routed to Codex/Responses accounts, this is the top-level Responses GPT model. Plain Images API backends may ignore it.",
            },
            {
              name: "thinking",
              requirement: "Optional",
              custom: true,
              description:
                "minimal, none, low, medium, high, or xhigh. Only applies to Codex/Responses backends; Web or plain Images API backends may ignore it.",
            },
            {
              name: "web_first / webFirst / force_web / forceWeb",
              requirement: "Optional",
              custom: true,
              description:
                "Only supported by image endpoints. Prefer web_first / webFirst; force_web / forceWeb are compatibility aliases with the same Web-first preference semantics, not hard Web-only routing. Mixed backend groups prefer Web accounts when the requested total pixels are between IMAGE_FORCE_WEB_MIN_PIXELS and IMAGE_FORCE_WEB_MAX_PIXELS. If Web is unavailable, fails, or is exhausted, routing falls back to Codex/Responses. The default range is 0.66MP-2MP; non-mixed or out-of-range requests ignore this field.",
            },
          ],
          responses: [
            {
              name: "created",
              description: "Unix timestamp in seconds.",
            },
            {
              name: "data[].b64_json / data[].url",
              description: "Base64 or URL according to response_format.",
            },
            {
              name: "data[].revised_prompt",
              description:
                "Returned when the upstream provides a revised prompt.",
            },
            {
              name: "generation_id / generationId",
              description:
                "FluxMedia extension. Non-stream success responses return the generation record ID at the top level.",
              custom: true,
            },
            {
              name: "credits_consumed",
              description:
                "FluxMedia extension. FluxMedia-billed credits for this request.",
              custom: true,
            },
            {
              name: "SSE image_generation.partial_image",
              description:
                "Only returned with stream=true or Accept: text/event-stream. Represents one partial image.",
            },
            {
              name: "SSE image_generation.completed",
              description:
                "Only returned in streaming mode. Indicates one image is complete; event data includes generation_id, credits_consumed, model, size, and the final image.",
            },
          ],
          notes: [
            "This endpoint does not call page /api/images/generate; it directly enters the shared service layer.",
            "When routed to a Responses account, the image request is converted into a Responses image_generation tool request.",
            "Each request creates exactly one generation record. Explicit n is rejected with HTTP 400; batch image generation is no longer supported.",
            "Concurrency and queueing are governed by the site-wide execution limit and the per-user image limit. The default user limit is 20 and can be overridden on the user edit page. Async tasks use the backend-group numeric priority in ascending order; smaller values run first.",
            "Waiting in a queue does not create a generation record or charge image credits. If the shared queue wait exceeds IMAGE_GENERATION_QUEUE_TIMEOUT_MS, the API returns a 429-style error. The 20-minute runtime timeout starts only after an individual image task begins execution, and timeout settlement follows the failed-generation credit rules.",
            "Web backends cannot strictly control output dimensions or output format. FluxMedia labels stored files by the detected image header and MIME.",
            "background=transparent is not universally supported. OpenAI's official docs currently list gpt-image-1.5, gpt-image-1, and gpt-image-1-mini as supporting transparent backgrounds, and png or webp output is usually required. Unsupported upstream models may reject the request with HTTP 400 instead of silently falling back.",
            "Async tasks are persisted in PostgreSQL and awakened by BullMQ. Recovery jobs continue unfinished work after restarts, instance switches, or temporary delivery failures.",
            "If the actual generated dimensions differ from the requested size, FluxMedia records and bills using the detected actual size.",
            "The official Images API may return usage. FluxMedia usually returns usage: null, but FluxMedia-billed credits are returned through top-level credits_consumed, error payloads, or streaming completion events.",
          ],
        },
        {
          title: "Create image edit",
          method: "POST",
          path: "/v1/images/edits",
          contentType: "multipart/form-data or application/json",
          description:
            "Compatible with OpenAI Images edit. multipart uploads files; JSON can reference public image URLs.",
          example: `# 1. multipart upload reference image.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-2" \\
  -F prompt="Turn the reference image into a cinematic poster" \\
  -F size="1024x1024" \\
  -F quality="high" \\
  -F moderation="auto" \\
  -F response_format="url" \\
  -F output_format="jpeg" \\
  -F output_compression="90" \\
  -F background="opaque" \\
  -F 'image[]=@/path/to/reference.png'

# 2. multipart multiple references + mask + Codex/Responses fields.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-2" \\
  -F prompt="Only redraw the masked area and keep the face unchanged" \\
  -F size="1536x1024" \\
  -F quality="medium" \\
  -F response_format="b64_json" \\
  -F promptOptimization="false" \\
  -F gpt_model="gpt-5.4" \\
  -F thinking="medium" \\
  -F 'image[]=@/path/to/person.png' \\
  -F 'image_2=@/path/to/style.png' \\
  -F mask="@/path/to/mask.png"

# 3. JSON image URLs. Prefer images; image_url/image_urls are shortcuts.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "Turn the reference into a clean ecommerce hero image",
    "images": [
      "https://example.com/reference.png",
      { "image_url": "https://example.com/detail.webp" }
    ],
    "image_url": "https://example.com/single-reference.png",
    "image_urls": ["https://example.com/extra.jpg"],
    "mask_url": "https://example.com/mask.png",
    "mask_image_url": "https://example.com/mask-alt.png",
    "size": "1024x1024",
    "quality": "auto",
    "moderation": "low",
    "response_format": "url",
    "output_format": "webp",
    "output_compression": 80,
    "background": "transparent",
    "prompt_optimization": false,
    "gptModel": "gpt-5.4-mini",
    "thinking": "low"
  }'

# 4. Prefer Web account scheduling for mixed groups within the configured pixel range. Failed or exhausted Web routing falls back to Codex/Responses.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "Keep the person and make it look like a cinematic still",
    "images": ["https://example.com/reference.png"],
    "size": "1024x1024",
    "response_format": "url",
    "web_first": true
  }'

# 5. Streaming image edit.
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -F model="gpt-image-2" \\
  -F prompt="Keep the composition and convert it to watercolor illustration" \\
  -F size="1024x1024" \\
  -F response_format="url" \\
  -F stream="true" \\
  -F 'image=@/path/to/reference.png'

# 6. Async image edit. You may also append ?async=true. callback_url is optional.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/edits \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-image-1.5" \\
  -F prompt="Remove the background and output a transparent PNG" \\
  -F size="1024x1024" \\
  -F response_format="url" \\
  -F output_format="png" \\
  -F background="transparent" \\
  -F async="true" \\
  -F callback_url="https://your-server.example/callback" \\
  -F 'image=@/path/to/reference.png'`,
          responseExample: `{
  "created": 1713833628,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "..."
    }
  ],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# SSE when stream=true
event: image_edit.partial_image
data: {"type":"image_edit.partial_image","index":0,"partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: image_edit.completed
data: {"type":"image_edit.completed","index":0,"generation_id":"...","generationId":"...","model":"gpt-image-2","size":"1024x1024","credits_consumed":1.31,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","revised_prompt":"..."}]}

# async=true task polling and callback shape match /v1/images/generations.
`,
          fields: [
            {
              name: "prompt",
              requirement: "Required",
              description: "Edit prompt, up to 32000 characters.",
            },
            {
              name: "image / image[] / image_*",
              requirement: "Required for multipart",
              description: "Reference image files, up to 16 images.",
            },
            {
              name: "images",
              requirement: "Optional for JSON",
              description:
                "Image reference array. FluxMedia accepts string URLs or { image_url/url }. file_id is not supported.",
            },
            {
              name: "mask",
              requirement: "Optional",
              description:
                "PNG mask file; JSON can provide a mask URL reference.",
            },
            {
              name: "model",
              requirement: "Required",
              description:
                "Exact image model ID returned by GET /v1/models for the current API key. Out-of-catalog IDs, firefly-* prefixes, and other aliases are not rewritten. The same rule applies to /v1/images/generations.",
            },
            {
              name: "size",
              requirement: "Optional",
              description: "Target size; omission is equivalent to auto.",
            },
            {
              name: "quality",
              requirement: "Optional",
              description: "auto, low, medium, or high.",
            },
            {
              name: "moderation",
              requirement: "Optional",
              description:
                "auto or low. Passed upstream as an image-edit parameter; it does not change FluxMedia's centrally managed content-moderation level.",
            },
            {
              name: "response_format",
              requirement: "Optional",
              description: "url or b64_json. Defaults to b64_json.",
            },
            {
              name: "output_format",
              requirement: "Optional",
              description:
                "png, jpeg, or webp. Controls the actual output image format; upstream support may vary.",
            },
            {
              name: "output_compression",
              requirement: "Optional",
              description:
                "compression level 0-100, only meaningful for jpeg/webp; higher = more compression, smaller file, lower quality (OpenAI-native output_compression semantics, passed through).",
            },
            {
              name: "background",
              requirement: "Optional",
              description:
                "transparent, opaque, or auto. Transparent backgrounds require support from the selected upstream model and usually require png or webp output. Unsupported models may return a 400 error such as “Transparent background is not supported for this model”. To still get a transparent result on an unsupported backend, also pass transparent_matte=true (see next field). Use auto or opaque when support is unknown.",
            },
            {
              name: "transparent_matte",
              requirement: "Optional",
              custom: true,
              description:
                "Defaults to false. Only takes effect when background=transparent and explicitly set to true: if the selected backend rejects transparent with a 400, the request is regenerated opaque and matted server-side (ISNet) into a transparent PNG. When off, transparent is passed through and an unsupported backend returns the real 400 error. Applies to single image generation/edit/chat only, not the agent layered mode.",
            },
            {
              name: "stream",
              requirement: "Optional",
              description: "true returns text/event-stream.",
            },
            {
              name: "async",
              requirement: "Optional",
              custom: true,
              description:
                "Async switch. Set body async:true OR append ?async=true to the URL (the two are equivalent). When on, the endpoint returns a task_... object immediately (status:processing) and runs the edit in the background; poll GET /v1/images/{task_id} for the result. Cannot be combined with stream (sending both returns async cannot be used with stream.).",
            },
            {
              name: "callback_url",
              requirement: "Optional",
              custom: true,
              description:
                "Completion-callback webhook (not a URL you poll). Async only: when the task completes or fails, the server POSTs the final task object to this URL with headers X-Tokens-Callback: true and Content-Type: application/json. The URL must be publicly reachable over http/https. An already-sent callback is unaffected even if the task later expires (30 min) or is lost on restart.",
            },
            {
              name: "image_url / image_urls",
              requirement: "Optional JSON or form field",
              custom: true,
              description:
                "Compatibility shortcut fields. Prefer images; when both are provided, FluxMedia merges them into one reference list and deduplicates by URL.",
            },
            {
              name: "mask_url / mask_image_url",
              requirement: "Optional JSON or form field",
              custom: true,
              description: "Convenience fields for a mask image URL.",
            },
            {
              name: "promptOptimization / prompt_optimization",
              requirement: "Optional",
              custom: true,
              description:
                "Controls whether FluxMedia may further optimize prompt. If prompt is already the final optimized prompt, pass false.",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "Optional",
              custom: true,
              description:
                'Safety prompt-repair retry toggle (issue #24). Defaults to the platform setting (usually enabled): when local moderation or an upstream safety refusal yields no image, the system rewrites the prompt through Responses and re-moderates and retries inside the same task. When explicitly false, this automatic rewrite-retry is disabled and a moderation failure returns the real error without rewriting the prompt. See "Safety Prompt Repair Retry" below.',
            },
            {
              name: "gptModel / gpt_model",
              requirement: "Optional",
              custom: true,
              description: "Same as Create image.",
            },
            {
              name: "thinking",
              requirement: "Optional",
              custom: true,
              description:
                "minimal, none, low, medium, high, or xhigh. Only applies to Codex/Responses backends; Web or plain Images API backends may ignore it.",
            },
            {
              name: "web_first / webFirst / force_web / forceWeb",
              requirement: "Optional",
              custom: true,
              description:
                "Only supported by image endpoints. Prefer web_first / webFirst; force_web / forceWeb are compatibility aliases with the same Web-first preference semantics, not hard Web-only routing. Mixed backend groups prefer Web accounts when the requested total pixels are between IMAGE_FORCE_WEB_MIN_PIXELS and IMAGE_FORCE_WEB_MAX_PIXELS. If Web is unavailable, fails, or is exhausted, routing falls back to Codex/Responses. The default range is 0.66MP-2MP; non-mixed or out-of-range requests ignore this field.",
            },
          ],
          responses: [
            {
              name: "created / data[]",
              description: "Same as /v1/images/generations.",
            },
            {
              name: "generation_id / generationId",
              description:
                "FluxMedia extension. Non-stream success responses return the generation record ID at the top level.",
              custom: true,
            },
            {
              name: "credits_consumed",
              description:
                "FluxMedia extension. FluxMedia-billed credits for this request.",
              custom: true,
            },
            {
              name: "SSE image_edit.partial_image",
              description:
                "Only returned with stream=true or Accept: text/event-stream. Represents one partial edited image.",
            },
            {
              name: "SSE image_edit.completed",
              description:
                "Only returned in streaming mode. Indicates one edited image is complete; event data includes generation_id, credits_consumed, model, size, and the final image.",
            },
          ],
          notes: [
            "URL images are downloaded server-side and checked for public reachability, type, and size.",
            "Private networks, localhost, metadata/internal hosts, and URLs with credentials are rejected.",
            "Official JSON file_id image references are not implemented. Use public image_url or multipart uploads.",
            "background=transparent is not universally supported. OpenAI's official docs currently list gpt-image-1.5, gpt-image-1, and gpt-image-1-mini as supporting transparent backgrounds, and png or webp output is usually required. Unsupported upstream models may reject the request with HTTP 400 instead of silently falling back.",
            "async tasks are process-local and expire after 30 minutes. A restart or multi-instance switch can make unfinished tasks unavailable for polling; already-sent callbacks are unaffected.",
          ],
        },
        {
          title: "Get async image task",
          method: "GET",
          path: "/v1/images/{task_id}",
          contentType: "No request body",
          description:
            "Extension: look up a single image generation by ID. The {task_id} path parameter accepts two kinds of ID: (1) the task_... created with async=true (an in-process in-memory task object that expires after 30 minutes and becomes unavailable after a restart or multi-instance switch); (2) the generation_id (gen_...) from any sync/async response, read persistently from the DB and available across restarts / multi-instance switches. It checks the in-memory task first, then looks up by generation_id. Only the caller's own records are returned.",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/images/task_... \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "id": "task_...",
  "object": "image",
  "model": "gpt-image-2",
  "status": "completed",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed": 1713833700,
  "completed_at": "2026-05-28T00:01:12.000Z",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "credits_consumed": 1.31,
  "usage": null
}

# While still running (status:processing, no data yet)
{
  "id": "task_...",
  "object": "image.generation",
  "model": "gpt-image-2",
  "status": "processing",
  "created": 1713833628,
  "created_at": "2026-05-28T00:00:00.000Z",
  "generation_id": "gen_..."
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "Required header",
              description: "Bearer <FluxMedia API Key>.",
            },
            {
              name: "task_id",
              requirement: "Required path parameter",
              custom: true,
              description:
                "ID (path parameter). Either the task_... returned with async=true (in-memory task; expires after 30 minutes, unavailable after restart / multi-instance switch), or the generation_id (gen_...) from any response (read persistently from the DB, available across restarts / multi-instance switches). Max length 128 chars; missing/over-length returns 400 Invalid task_id, not found / expired returns 404. Scoped to the owning user; only your own records are returned.",
            },
          ],
          responses: [
            {
              name: "id",
              description:
                "Task ID (task_...), matching {task_id} in the path.",
            },
            {
              name: "object",
              description:
                "image.generation while running, image once finished.",
            },
            {
              name: "status",
              description:
                "Task status: processing (running), completed (success), or failed (the object then includes error).",
            },
            {
              name: "data",
              description:
                "When status=completed, the image result array (same shape as /v1/images/generations, elements carry url or b64_json). Absent while still running.",
            },
            {
              name: "created / created_at / completed / completed_at",
              description:
                "Task create and completion times (unix seconds and ISO strings); completed* appear only after completion.",
            },
            {
              name: "generation_id / generationId",
              description: "The associated generation record ID.",
            },
            {
              name: "credits_consumed",
              description:
                "Credits settled on completion; 0 when a user-supplied API was used.",
            },
          ],
          notes: [
            "Tasks are persisted in PostgreSQL and awakened by BullMQ. Recovery jobs continue unfinished work after restarts, instance switches, or temporary delivery failures.",
            "You can only query tasks created by the user that owns the current API Key.",
            "The response matches exactly the task object POSTed to callback_url.",
          ],
        },
        {
          title: "Create video",
          method: "POST",
          path: "/v1/videos",
          contentType: "application/json",
          description:
            "Creates a persistent video task through the OpenAI-style POST /v1/videos route. Every valid request returns HTTP 202 with object=video.task after persistence; it never waits for the video on the current connection. Poll GET /v1/videos/{id} with the returned task ID, or configure callback_url for terminal delivery. Authentication uses the same API key mechanism as other v1 endpoints.",
          example: `# 1. Text-to-video. model is the real model ID; parameters are separate.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-001",
    "model": "veo31",
    "seconds": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "prompt": "A corgi running on the beach, cinematic camera, golden hour",
    "negative_prompt": "low resolution, blurry, watermark"
  }'

# 2. First/last-frame generation. Frames and reference images are mutually exclusive for every model.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-002",
    "model": "seedance2-fast",
    "duration_seconds": 10,
    "aspect_ratio": "9:16",
    "resolution": "720p",
    "prompt": "Make the person slowly look up and smile",
    "first_frame": "data:image/png;base64,iVBORw0KGgo...",
    "last_frame": "data:image/png;base64,iVBORw0KGgo...",
    "generate_audio": false
  }'

# 3. Compatibility async field. true, false, or omission creates the same persistent task.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_request_id": "video-request-003",
    "model": "veo31",
    "seconds": 8,
    "aspect_ratio": "16:9",
    "resolution": "1080p",
    "prompt": "City night timelapse, neon reflections",
    "async": true,
    "callback_url": "https://your-server.example/callback"
  }'
# Returns HTTP 202. Poll the same persistent task ID, or wait for callback_url:
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/video_0123456789abcdef0123456789abcdef01234567 \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "queued",
  "model": "veo31",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p"
}`,
          fields: [
            {
              name: "prompt",
              requirement: "Required",
              description: "Video prompt, up to 32000 characters.",
            },
            {
              name: "model",
              requirement: "Required",
              description:
                "Real video model ID, such as seedance2, seedance2-fast, or veo31. Do not encode duration, ratio, or resolution in the ID; legacy firefly-* and composite IDs are rejected. See /v1/models for available models.",
            },
            {
              name: "clientRequestId / client_request_id",
              requirement: "Required",
              description:
                "Caller-generated idempotency ID, up to 128 characters. Reuse it when retrying the same request.",
            },
            {
              name: "seconds / duration / duration_seconds",
              requirement: "Required",
              description:
                "Video duration in seconds; must be an integer supported by the selected model.",
            },
            {
              name: "aspectRatio / aspect_ratio",
              requirement: "Required",
              description:
                "Video aspect ratio, such as 16:9 or 9:16; must be supported by the selected model.",
            },
            {
              name: "resolution",
              requirement: "Required",
              description:
                "Lowercase resolution such as 480p, 720p, or 1080p; must be supported by the selected model.",
            },
            {
              name: "negative_prompt / negativePrompt",
              requirement: "Optional",
              description: "Negative prompt, up to 8000 characters.",
            },
            {
              name: "firstFrame / first_frame, lastFrame / last_frame",
              requirement: "Optional",
              description:
                "First frame and optional last frame as base64 image data URLs. lastFrame requires firstFrame; last-frame support is model-specific.",
            },
            {
              name: "referenceImages / reference_images",
              requirement: "Optional",
              description:
                "Ordered base64 image data URL array. The limit is model-specific; Seedance defaults to 10 and admins may configure it. Reference images and frame inputs are mutually exclusive for every model.",
            },
            {
              name: "generateAudio / generate_audio",
              requirement: "Optional",
              description:
                "Whether to generate audio. true is accepted only for models with audio capability.",
            },
            {
              name: "async",
              requirement: "Optional",
              custom: true,
              description:
                "Compatibility field. true, false, or omission creates the same persistent task and returns HTTP 202; it does not enable a synchronous mode. URL ?async is not a supported video mode switch.",
            },
            {
              name: "callback_url / callbackUrl",
              requirement: "Optional",
              custom: true,
              description:
                "Terminal webhook for the persistent task. The server POSTs terminal output to this public https URL when the task completes or fails. It is independent of async, and retries with the same clientRequestId must keep the callback URL unchanged.",
            },
          ],
          responses: [
            {
              name: "object",
              description: "Always video.task.",
            },
            {
              name: "id / task_id / generation_id",
              description:
                "The same persistent video task ID, used with GET /v1/videos/{id}.",
            },
            {
              name: "status",
              description:
                "Current task state: queued, in_progress, completed, or failed.",
            },
            {
              name: "model",
              description: "The real video model ID used.",
            },
            {
              name: "duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
              description:
                "Independent generation parameters saved on the task.",
            },
            {
              name: "generateAudio / generate_audio",
              description:
                "Returned as equivalent aliases when the create request explicitly includes the audio switch.",
            },
          ],
          notes: [
            "This endpoint is a FluxMedia extension, not an official OpenAI endpoint. The legacy /v1/videos/generations route remains supported long term, while /api/v1/videos and /api/v1/videos/generations are equivalent aliases.",
            "Every request returns HTTP 202 after the task is persisted. There is no synchronous wait mode, and URL ?async does not switch behavior.",
            "callback_url is attached to the persistent task and delivered at terminal state. An idempotent retry with the same clientRequestId cannot replace or add a callback URL.",
            "Billing = credits per second for the selected real model and resolution × the separate duration value, rounded up to the supported credit precision. Model, duration, ratio, and resolution are validated independently and are never parsed from model ID.",
            "Requires the externalApi.images.generate system capability switch, plus a valid API key, bound group, and sufficient account credits.",
          ],
        },
        {
          title: "Get video task",
          method: "GET",
          path: "/v1/videos/{id}",
          contentType: "No request body",
          description:
            "FluxMedia extension: looks up status by the persistent video task ID returned by the create endpoint. It reads only the database-backed video task and verifies API-key ownership; it does not consult the process-local async image task store.",
          example: `curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/videos/video_0123456789abcdef0123456789abcdef01234567 \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY"`,
          responseExample: `{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "completed",
  "model": "veo31",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "generateAudio": false,
  "generate_audio": false,
  "input": {"mode": "none", "count": 0},
  "video_url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
  "data": [{"url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}],
  "created_at": "2026-05-28T00:00:00.000Z",
  "completed_at": "2026-05-28T00:01:40.000Z"
}

# While still running, video_url and data are omitted.
{
  "object": "video.task",
  "id": "video_0123456789abcdef0123456789abcdef01234567",
  "task_id": "video_0123456789abcdef0123456789abcdef01234567",
  "generation_id": "video_0123456789abcdef0123456789abcdef01234567",
  "status": "in_progress",
  "model": "veo31",
  "duration": 8,
  "duration_seconds": 8,
  "aspectRatio": "16:9",
  "aspect_ratio": "16:9",
  "resolution": "1080p",
  "generateAudio": false,
  "generate_audio": false,
  "input": {"mode": "none", "count": 0},
  "created_at": "2026-05-28T00:00:00.000Z"
}`,
          fields: [
            {
              name: "Authorization",
              requirement: "Required header",
              description: "Bearer <FluxMedia API key>.",
            },
            {
              name: "id",
              requirement: "Required path parameter",
              custom: true,
              description:
                "The id, task_id, or generation_id from the create response; all three are the same persistent video task ID. Max length is 128 characters; missing or over-length values return 400 Invalid task_id. Access is scoped to the API-key owner.",
            },
          ],
          responses: [
            {
              name: "object",
              description: "Always video.task.",
            },
            {
              name: "id / task_id / generation_id",
              description:
                "The same persistent video task ID, matching {id} in the request path.",
            },
            {
              name: "status",
              description:
                "queued, in_progress, completed, or failed. error.message is included when an error is available.",
            },
            {
              name: "model, duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
              description:
                "The real model ID and independent generation parameters persisted on the task.",
            },
            {
              name: "generateAudio / generate_audio",
              description: "The effective audio switch used by the task.",
            },
            {
              name: "input.mode / input.count",
              description:
                "Input summary. mode is none, first-frame, first-last-frames, or references; count is the number of input images. Actual input images are not returned.",
            },
            {
              name: "data[].url / video_url",
              description:
                "When status=completed, the signed FluxMedia storage URL of the produced video (data[].url equals the top-level video_url); absent while running.",
            },
            {
              name: "created_at / completed_at",
              description:
                "ISO task creation timestamp. completed_at is included only after completion.",
            },
          ],
          notes: [
            "This endpoint is a FluxMedia extension, not an official OpenAI endpoint; /api/v1/videos/{id} is an alias.",
            "Only tasks created by the user that owns the current API key are queryable; the response is Cache-Control: no-store.",
            "Status and output come from the persistent video record; there is no 30-minute in-memory task expiry contract.",
          ],
        },
        {
          title: "Create Agent image run",
          method: "POST",
          path: "/v1/agents/images",
          contentType: "application/json or multipart/form-data",
          description:
            "FluxMedia extension that exposes the page Agent run style to external API clients. It uses Codex/Responses scheduling, web search, tool loop continuation, attachment context, and multi-round image iteration.",
          example: `# 1. JSON Agent image run. Enable the externalApi.agent system capability.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "prompt": "Search public information about Zhejiang Shuangyuan Technology and iterate an enterprise poster",
    "size": "1536x1024",
    "quality": "high",
    "thinking": "medium",
    "agent_max_rounds": 3,
    "agent_force_max_rounds": false,
    "response_format": "url"
  }'

# 2. With reference image URLs. images / image_url / image_urls are merged and deduplicated.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "image_model": "gpt-image-2",
    "prompt": "Analyze this product photo and create an ecommerce poster",
    "images": ["https://example.com/product.png"],
    "size": "1024x1024",
    "agent_max_rounds": 2
  }'

# 3. multipart reference image plus PDF/text attachments.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -F model="gpt-5.4" \\
  -F image_model="gpt-image-2" \\
  -F prompt="Read the attachment and create a trade-show poster" \\
  -F size="1536x1024" \\
  -F response_format="url" \\
  -F agent_max_rounds="3" \\
  -F 'image[]=@/path/to/reference.png' \\
  -F 'file=@/path/to/company-profile.pdf'

# 4. Streaming Agent events.
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/agents/images \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Accept: text/event-stream" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "image_model": "gpt-image-2",
    "prompt": "Search first, then iterate a technology-blue enterprise poster",
    "size": "1536x1024",
    "stream": true,
    "agent_max_rounds": 2,
    "agent_force_max_rounds": true
  }'`,
          responseExample: `{
  "object": "agent.image_run",
  "created": 1713833628,
  "generation_id": "gen_...",
  "generationId": "gen_...",
  "model": "gpt-5.4",
  "size": "1536x1024",
  "response_text": "Research and poster generation completed.",
  "agent_round_count": 2,
  "credits_consumed": 8.42,
  "data": [
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "...",
      "output_role": "agent_draft"
    },
    {
      "url": "${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...",
      "revised_prompt": "...",
      "output_role": "final"
    }
  ],
  "agent_events": [],
  "usage": null
}

# SSE when stream=true
event: agent.event
data: {"type":"agent.event","event":{"kind":"web_search","status":"completed","title":"Web search completed","detail":"Zhejiang Shuangyuan Technology official site"}}

event: agent.partial_image
data: {"type":"agent.partial_image","partial_image_index":0,"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/..."}

event: agent.completed
data: {"type":"agent.completed","generation_id":"...","generationId":"...","agent_round_count":2,"credits_consumed":8.42,"data":[{"url":"${DOCUMENTATION_BASE_URL_PLACEHOLDER}/api/storage/generations/...","output_role":"final"}]}
`,
          fields: [
            {
              name: "prompt",
              requirement: "Required",
              description: "Current Agent task, up to 32000 characters.",
            },
            {
              name: "model / gptModel / gpt_model",
              requirement: "Optional",
              description:
                "Top-level GPT/Responses model. If model is gpt-image-*, FluxMedia treats it as image_model for compatibility.",
            },
            {
              name: "image_model / imageModel",
              requirement: "Optional",
              description:
                "Image model used by the image_generation tool, usually gpt-image-*.",
            },
            {
              name: "images / image_url / image_urls",
              requirement: "Optional for JSON",
              description:
                "Public reference image URLs. The server downloads and validates public reachability, type, and size.",
            },
            {
              name: "image / image[] / image_*",
              requirement: "Optional for multipart",
              description:
                "Reference image files. Images plus attachments are limited by system media settings.",
            },
            {
              name: "file / file[] / attachment",
              requirement: "Optional for multipart",
              description:
                "Text, code, CSV, JSON, Markdown, XML, YAML, log, or PDF attachments. Text files become context; PDFs become Responses file inputs.",
            },
            {
              name: "history",
              requirement: "Optional",
              description:
                "Previous conversation array such as [{ role, text, imageUrls, variants }] for continuing an external Agent conversation.",
            },
            {
              name: "agent_max_rounds",
              requirement: "Optional",
              custom: true,
              description: "1 to 8. Caps automatic Agent iteration rounds.",
            },
            {
              name: "agent_force_max_rounds",
              requirement: "Optional",
              custom: true,
              description:
                "When true, runs exactly agent_max_rounds. When false, the model may stop through continue_generation.",
            },
            {
              name: "size",
              requirement: "Optional",
              description:
                "Target size; invalid values are rejected. Used as a runtime image_generation parameter inside Agent.",
            },
            {
              name: "quality",
              requirement: "Optional",
              description:
                "auto, low, medium, or high. Used as a runtime image_generation parameter inside Agent.",
            },
            {
              name: "moderation",
              requirement: "Optional",
              description:
                "auto or low. Passed upstream as an image_generation parameter inside Agent; it does not change FluxMedia's centrally managed content-moderation level.",
            },
            {
              name: "output_format",
              requirement: "Optional",
              description:
                "png, jpeg, or webp; controls the output image format. Used as a runtime image_generation parameter inside Agent.",
            },
            {
              name: "output_compression",
              requirement: "Optional",
              description:
                "compression level 0-100, only meaningful for jpeg/webp; higher = more compression, smaller file, lower quality (OpenAI-native semantics, passed through). Used as a runtime image_generation parameter inside Agent.",
            },
            {
              name: "background",
              requirement: "Optional",
              description:
                "transparent, opaque, or auto. Same meaning as /v1/images/generations.",
            },
            {
              name: "transparent_matte",
              requirement: "Optional",
              custom: true,
              description:
                "Defaults to false. Only when background=transparent and set to true: if the selected backend rejects transparent with a 400, the request is regenerated opaque and matted server-side (ISNet) into a transparent PNG; not effective in the agent layered mode. See /v1/images/generations.",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "Optional",
              custom: true,
              description:
                "FluxMedia extension: safety prompt-repair retry toggle. When false, a moderation failure returns the real error directly instead of rewriting the prompt and retrying.",
            },
            {
              name: "thinking",
              requirement: "Optional",
              custom: true,
              description: "minimal, none, low, medium, high, or xhigh.",
            },
            {
              name: "response_format",
              requirement: "Optional",
              description:
                "url or b64_json. Agent defaults to url to avoid oversized multi-round responses.",
            },
            {
              name: "stream",
              requirement: "Optional",
              description:
                "true or Accept: text/event-stream returns SSE and also requires externalApi.streaming.",
            },
          ],
          responses: [
            {
              name: "object / generation_id / model / size",
              description:
                "Agent run object, generation record, model, and size.",
            },
            {
              name: "data[]",
              description:
                "Images produced by this Agent run. output_role may be agent_draft or final; the final item is the default deliverable.",
            },
            {
              name: "agent_events[]",
              description:
                "Structured task events such as web search, image generation, and continue/stop decisions.",
            },
            {
              name: "credits_consumed",
              custom: true,
              description:
                "FluxMedia-billed credits. Agent always requires Codex/Responses capability. The current base round charge is 0; completed images use final image fixed prices and runtime review fees, without group multipliers.",
            },
            {
              name: "agent_round_count",
              custom: true,
              description: "Number of execution rounds for this Agent task.",
            },
            {
              name: "SSE agent.event / agent.text_delta / agent.thinking_delta / agent.delta / agent.partial_image / agent.completed / agent.failed",
              description:
                "Streaming task events, streaming previews, and final completion.",
            },
          ],
          notes: [
            "This endpoint is a FluxMedia extension, not an official OpenAI endpoint. /api/v1/agents/images is an alias.",
            "Requires the externalApi.agent system capability; administrators can change it in system settings.",
            "It forces requiresResponsesBackend and never schedules Web accounts; it can use Codex/Responses accounts or external API backends that support /responses.",
            "It does not call page /api/images/chat; it shares the runImageGenerationForUser service layer with page Agent.",
          ],
        },
        {
          title: "Create response",
          method: "POST",
          path: "/v1/responses",
          contentType: "application/json",
          description:
            "A FluxMedia image-generation adapter based on the OpenAI Responses API. It routes as responses and selects Codex/Responses groups or external /responses API backends.",
          example: `# 1. Minimal Responses image request. Requires an API key, available group, and sufficient credits.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Generate a 1:1 futuristic product render",
    "size": "1024x1024",
    "quality": "high",
    "moderation": "auto"
  }'

# 2. Explicit image_generation tool with image model.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "input": "Generate a landscape technology product key visual",
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1536x864",
    "quality": "medium",
    "reasoning": { "effort": "low" },
    "store": true
  }'

# 3. Responses input with a reference image.
curl ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4-mini",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Use this image as reference and make a winter poster" },
          { "type": "input_image", "image_url": "https://example.com/reference.png" }
        ]
      }
    ],
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1024x1024",
    "output_format": "webp",
    "output_compression": 85,
    "moderation": "low"
  }'

# 4. Continue a previous response and stream the result.
curl -N ${DOCUMENTATION_BASE_URL_PLACEHOLDER}/v1/responses \\
  -H "Authorization: Bearer $GPT2IMAGE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-5.4",
    "previous_response_id": "resp_previous_id",
    "input": "Add a moon based on the previous image",
    "tools": [{ "type": "image_generation", "model": "gpt-image-2" }],
    "size": "1024x1024",
    "reasoning": { "effort": "minimal" },
    "stream": true
  }'`,
          responseExample: `{
  "id": "resp_...",
  "object": "response",
  "created_at": 1713833628,
  "status": "completed",
  "model": "gpt-5.4",
  "output": [
    {
      "id": "ig_...",
      "type": "image_generation_call",
      "status": "completed",
      "result": "..."
    }
  ],
  "usage": null,
  "metadata": {
    "generation_id": "...",
    "credits_consumed": 1.31,
    "size": "1024x1024"
  }
}

# SSE when stream=true
event: response.output_item.done
data: {"type":"response.output_item.done","item":{"id":"ig_...","type":"image_generation_call","status":"completed","result":"..."}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_...","object":"response","created_at":1713833628,"status":"completed","model":"gpt-5.4","output":[{"id":"ig_...","type":"image_generation_call","status":"completed","result":"..."}],"usage":null,"metadata":{"generation_id":"...","credits_consumed":1.31,"size":"1024x1024"}}}
`,
          fields: [
            {
              name: "model",
              requirement: "Optional",
              description:
                "Top-level Responses model. Availability is determined by /v1/models and the API key's bound group.",
            },
            {
              name: "input",
              requirement: "Required",
              description:
                "A string or message array. Message content supports strings, input_text/output_text, and input_image.image_url.",
            },
            {
              name: "previous_response_id",
              requirement: "Optional",
              description:
                "Continues a previous response. FluxMedia loads stored webConversation/fallbackHistory continuation state.",
            },
            {
              name: "tools",
              requirement: "Optional",
              description:
                'If provided, must include { type: "image_generation" }. If omitted, FluxMedia adds image_generation automatically. Put the image model in the image_generation tool\'s model field.',
            },
            {
              name: "tool_choice",
              requirement: "Optional",
              description:
                "Accepted for compatibility. Do not force it in chat or multi-tool runs unless needed, because it can prevent the model from using web search, code interpreter, or image generation together.",
            },
            {
              name: "stream",
              requirement: "Optional",
              description: "true returns Responses-style SSE events.",
            },
            {
              name: "store",
              requirement: "Optional",
              description:
                "Accepted for compatibility. FluxMedia stores continuation state internally and does not guarantee official store semantics.",
            },
            {
              name: "reasoning.effort",
              requirement: "Optional",
              description:
                "Supports minimal, none, low, medium, high, and xhigh. Actual support depends on the selected backend.",
            },
            {
              name: "size",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field used as the run-time image size when the image_generation tool does not provide one.",
            },
            {
              name: "quality",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field used as the run-time image quality.",
            },
            {
              name: "moderation",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field passed upstream as the runtime image moderation setting. It does not change FluxMedia's centrally managed content-moderation level.",
            },
            {
              name: "output_format",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field used as the run-time output_format when the image_generation tool does not provide one. You may also put it directly in the image_generation tool.",
            },
            {
              name: "output_compression",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field used as the run-time output_compression when the image_generation tool does not provide one.",
            },
            {
              name: "background",
              requirement: "Optional",
              description:
                "transparent, opaque, or auto, used as this run's background. See /v1/images/generations.",
            },
            {
              name: "transparent_matte",
              requirement: "Optional",
              custom: true,
              description:
                "Defaults to false. Only when background=transparent and set to true: if the selected backend rejects transparent with a 400, the request is regenerated opaque and matted server-side (ISNet) into a transparent PNG; not effective in the agent layered mode. See /v1/images/generations.",
            },
            {
              name: "promptRepair / prompt_repair",
              requirement: "Optional",
              custom: true,
              description:
                "Convenience field: safety prompt-repair retry toggle. When false, a moderation failure returns the real error directly instead of rewriting the prompt and retrying.",
            },
          ],
          responses: [
            {
              name: "id / object / created_at / status / model / output",
              description:
                "Compatible with the basic Responses response object.",
            },
            {
              name: "output[].type = image_generation_call",
              description: "Image result is returned in result as b64_json.",
            },
            {
              name: "output[].type = message",
              description:
                "Upstream text, when present, is returned as output_text.",
            },
            {
              name: "metadata.generation_id / credits_consumed / size",
              description:
                "FluxMedia generation record, billed credits, and size metadata.",
              custom: true,
            },
            {
              name: "SSE response.output_item.done / response.completed",
              description: "Streaming output item and completion events.",
            },
            {
              name: "SSE response.output_text.delta / response.reasoning_summary_text.delta",
              description: "Text and reasoning summary delta events.",
            },
          ],
          notes: [
            "This endpoint requires a valid API key, available group, and sufficient account credits.",
            "This is not Chat Completions. Use /v1/chat/completions for normal chat-to-image, and this endpoint for Responses tool semantics.",
            "input_image supports image_url/data URLs. file_id/file inputs are not used as references today.",
            "If tools is provided without image_generation, FluxMedia returns an error to avoid text-only responses.",
            "Page Chat mode uses normal multimodal chat/image semantics. Agent mode provides image_generation, web_search, and the linear continuation tool continue_generation by default without forcing tool_choice.",
            "Page Chat/Agent can read uploaded local text/code files as request context. Prompted server filesystem paths are not read.",
            "The current Page Chat/Agent base round charge is 0; completed images are billed by actual size, count, and moderation cost.",
            "Agent feeds the previous round's text, tool outputs, and generated draft images into the next round so the model can decide whether to refine again. The cap is IMAGE_AGENT_MAX_ROUNDS, default 3.",
            "Multiple Agent image_generation_call outputs are shown as automatic iteration variants, with the last image selected by default.",
          ],
        },
      ],
    },
    web: {
      title: "Web Accounts",
      description:
        "Uses ChatGPT Web image generation. It can reuse Web account quota, but it is not a strictly parameterized Images/Responses API.",
      valid: [
        "**Resolution is not strictly controllable; size is only a hint/record value and output may differ.**",
        "**4K output is not guaranteed; high-resolution output depends on current ChatGPT Web capability and account state.**",
        "The main GPT conversation model and Web thinking level can be controlled; image model is not mapped to a separate Web image model.",
        "When prompt optimization is off, FluxMedia sends the original prompt and forces Web thinking to instant to reduce platform-side rewriting.",
      ],
      invalid: [
        "External /v1/responses is adapted into the shared chat generation path, but its scheduling type remains responses; it only selects Codex/Responses groups or external Responses API backends, not Web account pools.",
        "For external /v1/responses, an empty model uses the backend default; explicit models must be listed by /v1/models or FluxMedia rejects them.",
        "Cannot guarantee prompt text is never interpreted, expanded, or revised by ChatGPT Web upstream.",
      ],
    },
    codex: {
      title: "Codex / Responses Accounts",
      description:
        "Uses Responses semantics and is the most parameterized system-account backend.",
      valid: [
        "GPT model is sent as the top-level Responses model.",
        "Image model is sent as the image_generation tool model.",
        "size, quality, moderation, reference images, and mask are assembled into the Responses tool request.",
        "Page Chat mode uses normal multimodal chat/image semantics. Page Agent mode provides image_generation, web_search, and continue_generation by default without forcing tool_choice, and can continue across linear automatic rounds so the model can search, read uploaded text-file context, generate drafts, and refine like Codex.",
        "Uploaded local text/code files in Chat/Agent are read as request context. Server filesystem paths written in prompts are not read.",
        "Supports external /v1/responses and can also handle converted /v1/images/generations and /v1/images/edits requests.",
        "When prompt optimization is off, FluxMedia instructs the model not to modify the prompt; this is best effort and upstream may still deviate.",
        "The current Page Chat/Agent base round charge is 0; completed images are billed by actual size, count, and moderation cost.",
      ],
      invalid: [
        "Not ChatGPT Web, so Web-only capability or quota semantics do not apply.",
        "On rate limits, quota errors, or invalid credentials, the scheduler cools down/marks the account and tries another one.",
      ],
    },
    adobe: {
      title: "Adobe (Firefly) Account",
      description:
        "A self-managed account/token pool that connects directly to Adobe Firefly, attached to a group as a special priority member for fallback.",
      valid: [
        "**Resolution only accepts the 1k / 2k / 4k tiers, not arbitrary pixel resolutions; the incoming size is auto-mapped to the nearest ratio (1x1/16x9/9x16/4x3/3x4) and nearest tier (long edge <=1024 -> 1k, <=2048 -> 2k, otherwise 4k).**",
        "Only exact model IDs exposed in the current group's Adobe member supportedModelIds can reach that member; client prefixes and aliases do not participate in routing.",
        "Self-managed account/token pool, attached to a group as a special priority member for fallback.",
      ],
      invalid: [
        "Unsupported parameters are silently ignored rather than rejected.",
        "Cannot output arbitrary pixel sizes; output always lands on one of the 1k/2k/4k tiers.",
      ],
    },
    api: {
      title: "External API Backends",
      description:
        "Uses an admin-configured OpenAI-compatible Base URL/API Key. Final capability depends on that service.",
      valid: [
        "Interface mode only declares which upstream endpoints exist: Images-only participates in image generation/edit only; Responses-only participates in Chat/Agent/Responses unless Images upstream is set to Responses; Mixed API can participate in both sides.",
        "Images upstream independently controls image generation/edit: native Images calls external /images/generations and /images/edits; Responses conversion calls external /responses + the image_generation tool.",
        "Chat Completions upstream independently controls /v1/chat/completions: Responses image mode calls external /responses; native mode calls external /chat/completions.",
        "Model, size, quality, streaming events, and usage fields depend on the external API implementation.",
      ],
      invalid: [
        "Does not consume FluxMedia Web or Codex account pool quota.",
        "If the external service rewrites prompts or limits resolution, FluxMedia cannot override it.",
      ],
    },
    prompt: {
      title: "Prompt Optimization And Thinking",
      rows: [
        [
          "Prompt optimization on",
          "Optimized prompt may be used; Web thinking follows the selected value.",
        ],
        [
          "Prompt optimization off",
          "Original prompt is sent; Web is forced to instant to minimize changes.",
        ],
        [
          "Codex/Responses",
          "When prompt optimization is off, FluxMedia instructs the model not to modify the prompt, but final behavior still depends on the upstream model/tool.",
        ],
        [
          "External API",
          "The platform passes through where possible; the external service decides final behavior.",
        ],
      ],
    },
    postProcess: {
      title: "Super-Resolution And HD Repair",
      rows: [
        [
          "Super-resolution (auto)",
          "Web / Codex backends often return images smaller than requested (Codex in particular does not strictly honor size). When a final image's longer edge falls below 2/3 of the target, the platform auto-upscales it to the target size with Real-ESRGAN (no crop, aspect preserved) — so Web / Codex reliably deliver near-4K target resolution, i.e. 4K is supported. Controlled by the admin 'resolution super-resolution' switch; ~1-2s per image.",
        ],
        [
          "HD repair (manual)",
          "Independent of super-resolution. When the user checks 'HD repair' or the API sends hd_repair=true, the final image is restored with SCUNet (denoise / de-blocking / detail enhancement, no size change). CPU-heavy (about 11s at 512, 35s at 1024) and serialized server-side, so it takes longer; controlled by the admin 'HD repair (SCUNet)' switch, off by default and opt-in per request.",
        ],
        [
          "Generative repair (manual, gpt-image-2)",
          "Unlike HD repair, this redraws through the real generation backend. When the user checks 'Generative repair' or the API sends block_repair=true, the final image is shrunk to the web sweet-spot resolution (~1280) and redrawn once with gpt-image-2 img2img (fixing text/detail while keeping composition and content unchanged, using repair_prompt or a built-in default), then upscaled to the target size. A single whole-image redraw means no seams (no tiling, no overlap ghosting); one extra backend call billed separately — slower and costlier than super-resolution / HD repair; controlled by the admin 'Generative repair' switch, off by default and opt-in. When active it replaces auto super-resolution.",
        ],
        [
          "Order & composition",
          "Super-resolution and HD repair can stack: restore first (native resolution, cheaper), then upscale to target. Generative repair, when enabled, upscales to target itself and replaces auto super-resolution. Nothing crops or changes aspect ratio; on any failure it falls back to the original and never blocks generation.",
        ],
      ],
    },
    roadmap: {
      title: "Roadmap",
      items: [
        "Sub2API non-database interface: current sync uses SUB2API_POSTGRES_URL to connect to Sub2API PostgreSQL. Future work should evaluate the Sub2API admin key / HTTP API path for account lookup, group filtering, status reads, error cleanup, and sync jobs; keep direct DB access only as a fallback when the API lacks required fields.",
        "PSD generation API: prepare support for PSD/layered outputs by defining the upstream contract, MIME/extension handling, storage and preview behavior, credit billing, external API response fields, capability matrix switch, and page download entry.",
        "Image reference UX: improve atomic @图1 and @第N轮图M tokens, remap references after image reorder, and surface missing-reference warnings.",
        "Agent branching: when editing or regenerating an older round, fork a new branch instead of overwriting later records.",
      ],
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
 * 渲染 Agent 能力与限制说明。
 *
 * @param agent 当前语言的 Agent 文档数据。
 * @returns 双栏能力卡片；空列表仍保持布局稳定。
 */
function AgentDocs({
  agent,
}: {
  agent: typeof sections.zh.agent | typeof sections.en.agent;
}) {
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="font-serif text-lg tracking-tight">
          {agent.title}
        </CardTitle>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {agent.description}
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border bg-muted/20 p-4">
          <ListBlock items={agent.valid} type="valid" />
        </div>
        <div className="rounded-md border bg-muted/20 p-4">
          <ListBlock items={agent.invalid} type="invalid" />
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
                // Adobe（Firefly）后端与异步任务（async）两条规则加粗并取消灰字,
                // 使其在通用规则里更醒目。前缀严格匹配,避免误命中无关条目:
                // "Adobe"(zh/en 共用)、"异步任务（async）"(zh)、"Async tasks (async)"(en)。
                const emphasize =
                  item.startsWith("Adobe") ||
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
        {/* 参数名常把多个等价别名用 " / " 串联（如 "size / quality / moderation"）。
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
  const endpoints = content.externalDocs.docs.filter((endpoint) =>
    endpoint.path.startsWith("/v1/videos")
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
  // 「后端落点」复用路由图列标题指代下方四张后端能力卡。
  const tocItems = [
    { id: "flow", label: content.flow.title },
    { id: "relationship", label: content.relationship.title },
    { id: "moderation-repair", label: content.moderationRepair.title },
    { id: "agent", label: content.agent.title },
    { id: "external-api", label: content.externalDocs.title },
    { id: "route-tables", label: content.routeTables.title },
    { id: "backends", label: content.flow.backendTitle },
    {
      id: "api-upstream-adapter",
      label: locale === "zh" ? "API 账号上游适配" : "API upstream adapters",
    },
    { id: "prompt", label: content.prompt.title },
    { id: "post-process", label: content.postProcess.title },
    { id: "roadmap", label: content.roadmap.title },
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

      <Card className="scroll-mt-32 rounded-lg" id="moderation-repair">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.moderationRepair.title}
          </CardTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {content.moderationRepair.description}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border bg-muted/20 p-4">
            <ListBlock items={content.moderationRepair.valid} type="valid" />
          </div>
          <div className="rounded-md border bg-muted/20 p-4">
            <ListBlock
              items={content.moderationRepair.invalid}
              type="invalid"
            />
          </div>
        </CardContent>
      </Card>

      <div className="scroll-mt-32" id="agent">
        <AgentDocs agent={content.agent} />
      </div>

      <div className="scroll-mt-32" id="external-api">
        <ExternalApiDocs baseUrl={baseUrl} docs={content.externalDocs} />
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
        {[content.web, content.codex, content.adobe, content.api].map(
          (section) => (
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
          )
        )}
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

      <Card className="scroll-mt-32 rounded-lg" id="roadmap">
        <CardHeader>
          <CardTitle className="font-serif text-lg tracking-tight">
            {content.roadmap.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {content.roadmap.items.map((item) => (
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
