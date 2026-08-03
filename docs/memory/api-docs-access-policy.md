# API 文档访问边界

## 路由与受众

- `/{locale}/api-docs`：公开接入文档，面向外部开发者，无需登录。
- `/{locale}/dashboard/api-docs`：接入文档的控制台镜像，面向所有已登录用户。
- `/{locale}/docs/**`：内部系统文档，仅 `admin`、`super_admin` 可访问。
- `/{locale}/dashboard/backend-help`：内部系统文档的控制台镜像，使用同一管理员守卫。
- `/api/search`：Fumadocs 内部文档搜索索引，未登录返回 401，非管理员返回 403。

公开导航指向 `/api-docs`；控制台侧栏、API 密钥页和支持中心默认入口指向
`/dashboard/api-docs`，避免已登录用户离开控制台框架。管理员控制台额外显示
`/dashboard/backend-help`。

## 公开内容边界

公开页与控制台镜像共用同一数据源，当前包含以下八个现行端点：

- `GET /v1/models`
- `GET /v1/credits`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `GET /v1/images/{task_id}`
- `POST /v1/videos/generations`
- `GET /v1/videos/capabilities`
- `GET /v1/videos/{id}`

请求参数、响应字段和示例不展示 `custom: true` 或其他明确的 FluxMedia 扩展字段。图片
任务 GET 端点的 `task_id` 属于路径契约不可缺少的参数，公开页显式保留。模型列表按当前
API 密钥的套餐能力、绑定分组和启用成员过滤；积分端点同时展示账户余额与密钥独立额度。
视频端点只使用真实模型 ID，并把时长、比例和分辨率作为独立参数。契约由
`api-integration-docs-data.test.ts` 防回归。

请求参数表为参数、要求、默认值、说明四列。所有公开可选参数必须声明默认行为；其中
图片 `model` 必填并应先从 `/v1/models` 查询；`n=1`、`size=1024x1024`、
`quality=auto`、`moderation=auto`、`response_format=b64_json`、`stream=false`，图生图
`mask` 默认为无。`output_format`、`output_compression`、`background` 本站不强制固定值，
明确标为由上游决定，禁止凭兼容 API 的常见值猜写。`output_compression` 控制 JPEG/WebP
输出图片的压缩级别，数值越大压缩力度越大；`0` 表示不压缩，`100` 表示最大压缩。
通常压缩越强，文件越小、画质损失越明显；不同上游的实际结果可能略有差异。

接入页 Base URL、全部 curl 示例、首页快速集成和 API 密钥控制台统一读取
`getSiteBaseUrl()`，其来源是 `NEXT_PUBLIC_APP_URL`；禁止在任一入口单独硬编码生产域名。

公开页的接口区使用响应式滚动电梯：桌面端显示粘性侧栏，窄屏显示粘性横向导航；活动
章节随滚动位置更新，并通过文字、背景和 `aria-current` 同时表达。
控制台镜像复用相同电梯；控制台内容容器在该路由保持 `overflow: visible`，避免横向滚动
祖先破坏桌面端 `sticky`，具体代码块和长字段仍由组件自身承担横向滚动。
独立接入页内容宽度上限与系统文档一致为 1600px；控制台镜像使用嵌入模式，不重复
叠加文档组件的横向内边距，避免正文两侧留白过大。

## 代码块

shadcn/ui 核心没有官方 Code Block。项目在 `@repo/ui/components/code-block` 按现有
shadcn 模式沉淀共享组件，提供语言标签、行号、横向滚动、复制成功/失败反馈；公开接入
文档与管理员系统文档共用，避免在营销布局引入会覆盖响应式样式的 Fumadocs 全局 CSS。
