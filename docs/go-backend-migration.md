# Go 后端迁移契约与验证记录

更新于 2026-09-14。Next.js 负责页面、静态资源、输入/输出契约与向 Go 转发请求；
运行中的 API、身份验证、持久化和后台任务由 `services/api-gateway` 实现。
Go 不把业务请求回传给 Next.js。博客/落地页列表 API 已由 Go 提供；MDX 内容详情的
文件读取、组件编译与页面渲染仍保留在 Next.js，这是静态内容页面职责。

## 当前审计结果

本次重新检查覆盖 Next.js 路由、Server Actions、UOL 启动绑定、实际 Go 路由表，以及
从 Web 启动入口可达的数据库、Redis 和队列依赖。源码清单位于
`docs/go-migration-inventory.json`，通过以下命令重建并验证：

```bash
node scripts/audit-go-migration.mjs --write --details
go -C services/api-gateway run . --route-audit
pnpm --filter @repo/web exec vitest run src/server/uol-migration-boundary.test.ts
```

当前静态清单包括 52 个路由文件、88 个导出的 HTTP 方法、27 个 Server Action 文件、
123 个 Action 导出和 187 个 operation。这些是不同层的入口，存在重叠，不能相加作为
接口总量或迁移百分比。

- Go 路由检查覆盖 102 个后端拥有的展开 HTTP 方法，包括显式枚举的认证子路由；缺失为 0。
  `GET/POST /api/admin/system-updates` 是由 Next.js 直接调用 GitHub 的平台控制面接口，
  通过显式路径豁免保留在 Next.js，不属于 Go 后端迁移边界。
- 额外抽取了 226 处可静态确定路径和方法的 Go 调用，去重后 125 个方法/路径组合；
  实际 ServeMux 均有匹配，防止仅检查 `route.ts` 遗漏 Server Action 的 405。
- Web 运行时依赖图中的 `@repo/database` 导入为 0；直接数据库驱动、Redis 和队列
  基础设施导入为 0。检查包括运行时 re-export、字面量动态 import 和 createRequire。
- 实际初始化全部 UOL 模块后，注册表与清单中的 187 个名称一致，执行体均已替换
  `Not yet wired` / `must be bound at app level` 占位实现。
- 55 个数据库引用文件属于当前 Web 运行时入口不可达的旧仓储和辅助代码，不是
  55 个仍由 Next.js 处理的接口。依赖包和这些旧文件仍用于离线维护、历史契约测试，
  尚未做源文件删除式清理。

审计图以 `apps/web/src/app`、instrumentation、proxy 和 UOL 启动模块为入口，沿可解析
的字面量模块依赖遍历；不是逐函数控制流证明。另有 29 处传输包装函数使用动态路径
或 RequestInit，列在 `dynamicGoRequests`，不算静态方法覆盖；其调用依赖对应模块的
HTTP 集成测试。`complete: true` 只表示该路由和依赖边界检查通过，不表示真实供应商、
支付或生产发布已完成验证。旧清单版本会被拒绝，发布前必须重新生成。
绑定存在也不证明功能可用：本轮发现积分包结账曾被错误替换为本地 410，已恢复实际
Go 请求，并增加调用真实 UOL operation、核对方法/正文/返回值和错误的行为回归。

## 已接管的业务边界

- 管理员资料 PATCH 已补齐头像写入：省略保留、显式 null 清空，设置/清空均要求超级
  管理员；名称、邮箱和头像与前后值审计在同一事务提交，非法头像不会先写入其他资料。
- 认证、注册、验证码、密码重置、OAuth、会话及账号管理沿用现有用户/会话表与 Cookie；
  Go 从真实会话或 API Key 读取身份和角色，客户端正文不能选取执行身份。
- 积分账户、批次、消费/退款、幂等操作、API Key 配额、充值、支付履约与返佣在 Go 的
  PostgreSQL 事务中完成。记录、管理员全局使用日志和历史分页由 Go 查询。
- 积分包列表由 `GET /api/credits/packages` 返回可见套餐数组，积分包结账由
  `POST /api/credits/purchase-checkout` 处理；Server Action 与 UOL 只转发套餐、数量、
  语言和幂等请求 ID，会话决定用户身份，正文不能传入 userId。保留 Epay 表单和 Creem
  跳转两种返回契约，以及校验、未配置和幂等冲突的稳定状态。
- 按金额支付宝充值使用 Go RSA2 签名调用 HTTPS precreate 并验签返回结果；金额、
  积分汇率和有效期在创建时冻结，创建租约和每用户 UUID 幂等支持重试与恢复。
  公开/内部回调验证 AppID、SellerID、币种及订单用途，并与履约和生命周期事件联动。
- 模型配置、价格、图片尺寸、供应商与分组、用户并发配额、站点设置、审核策略、
  公告、支持工单、管理搜索及统计接口均连接 Go；设置读取失败不会伪装成空配置。
- 脚本运行时诊断读取私有进程的实际 Worker、请求/响应队列、响应许可、饱和与替换
  计数；不可达时返回 503。私有运行时恢复有界队列、响应优先级、许可过期与断连回收。
  图片/视频外呼前申请响应处理容量，许可只存在于私有传输中，取消或失败也会释放。
  图片持久提交标记在准入成功后、实际外呼前写入；准入拥堵等待恢复，已发送的请求
  不因响应脚本故障重复提交。
- 图片创建入口和视频调度执行 `priority`、`least_acquired`、`least_load` 策略，
  供应商累计租约、调度时间桶及成功/失败健康状态由 Go 事务更新。持久回执防止
  轮询、续租和重复投递重复计数；输入错误、内容审核拒绝和运行时拥堵不处罚供应商。
- 图片和视频生成、参考图暂存、供应商协议、预览、回调、状态恢复、扣费、删除、
  过期清理、后台对账和媒体存储由 Go 管理。
- 运营总览使用真实事实表和一致性快照，支持自然日/周/月、比较窗口、留存、
  支付阶段及币种、内容、健康指标。明细使用绑定操作者、筛选、时区及快照的签名游标。
- 运营导出的创建、重试、状态、CSV、存储和下载由 Go 执行；Web 的下载路由和 UOL
  适配器只传输响应流。
- 管理员文档搜索只读取实际 `src/content/docs` 集合，返回 Fumadocs 使用的结果数组
  与规范 `/docs` 页面/章节链接；支持标题/正文、中文片段、tag 与 limit。签名读取 URL
  按数字 `expiresIn` 生效并验证范围，不再把指定短有效期静默替换成默认一小时。
- 限流设置和计数已移至 Go。Go 以 Redis 原子滑动窗口实现跨实例计数，Redis 故障时
  使用有界本地回退；Dashboard 及媒体入口直接请求 Go 时也受同一会话限流约束。
  默认忽略不可信的转发 IP 头；只有显式启用并匹配可信代理 CIDR 才使用它们。

MCP 已退役，兼容入口明确返回 410；此前移除的 Chat、Responses、Agent、PPT 和 editable
功能不恢复。不能把这些有意关闭的接口列为等待迁移的能力，也不能为“迁移完成”重新启用。
审核提示词自动修剪也已在迁移前退役：`40d7050c` 删除执行循环，`9c3bb1cd` 删除设置，
对应数据库迁移删除存量键；这些提交均为首个 Go 迁移提交 `1eb86686` 的祖先。
系统文档同步移除过期说明，保留历史记录元数据兼容。

## 运行拓扑

```text
浏览器 / Nginx
  ├── 页面与静态资源 → Next.js web
  └── API / 媒体 / Webhook → Go backend

Next.js Server Actions / UOL 适配器 → Go backend（转发会话）

Go backend
  ├── PostgreSQL：用户、配置、任务、租约、事实、账本与幂等状态
  ├── Redis：任务唤醒、并发控制和限流
  ├── 本地 / S3 对象存储
  ├── 外部媒体、审核、邮件与支付供应商
  ├── 私有 QuickJS 脚本运行时 :8090
  └── 私有 ONNX / sharp 图像计算运行时 :8091
```

私有运行时不持有数据库或用户状态。统一 supervisor 只向 QuickJS 与媒体子进程传递各自
必需的环境变量白名单，不传递数据库、Redis、认证或供应商密钥。QuickJS 执行供应商适配脚本；媒体计算运行时执行
SCUNet 修复、RealESR 超分、ISNet 抠图及扩图像素处理。Go 决定调用权限、任务状态、
修复供应商、费用和存储，Node 运行时只返回计算结果。保留这些计算进程不代表仍有
Next.js 业务接口。该白名单用于减少意外暴露，并不把同一容器内的进程变成独立安全边界；
需要抵御容器内进程互相读取时仍应拆分容器或使用更强的运行时隔离。

源码开发仍以 web、backend、script-runtime、media-processing 四个进程运行，便于独立
调试。根目录自托管 Compose 与生产 `deploy/docker-compose.yml` 都把这四个进程装入统一
`app` 容器；`Dockerfile.unified` 生成不可变镜像，由 PID 1 监管并转发终止信号，任一关键
进程意外退出都会让整个容器失败。生产 Web 和 Go 只向宿主机回环地址发布 `3000` 与
`3001`，QuickJS 与 ONNX/Sharp 仅在容器内监听 `127.0.0.1:8090` 和 `127.0.0.1:8091`。
Next.js 到 Go 以及 Go 到两个私有运行时都固定使用 `127.0.0.1`，不依赖 Compose DNS。
镜像当前固定构建为 `linux/amd64`，与生产工作流、Go 二进制及 ONNX/Sharp x64 原生模块一致。

本地 Go 启动时可先执行现有 Drizzle journal / SQL 迁移，使用数据库锁避免并发迁移
冲突。生产发布在维护窗口内用候选 `app` 镜像恰好执行一次迁移，常驻容器设置
`GO_BACKEND_SKIP_MIGRATION=true`，避免四进程启动时重复迁移；`/readyz` 检查 PostgreSQL
和 Redis。数据库时间以 UTC 处理，
`APP_TIME_ZONE` 仅定义展示与统计自然日。Go 媒体 worker 以 PostgreSQL 为持久队列，
Redis 发布/订阅只用于唤醒，并定时补扫，丢失唤醒不会丢失任务。

`Dockerfile.web`、`Dockerfile.api-gateway`、`Dockerfile.api-upstream-script-runtime` 与
`Dockerfile.media-processing-runtime` 继续保留作组件专项构建和诊断；生产只构建、推送
`Dockerfile.unified`。统一镜像保留 Node 维护脚本环境供发布门禁、离线回填和治理脚本
使用；在线 SQL 迁移、HTTP 和任务执行仍由 Go 负责。不能把镜像内存在 Node 或依赖包
视为存在可达 Next.js 数据库接口。

## 验证证据与限制

本轮补漏后的完整回归：Web 328 个测试文件 / 2269 个测试通过；Shared 132 个文件 / 1235 个
测试通过。全部 Go 业务代码稳定后，重新执行完整 PostgreSQL 集成测试与 race 检查，
通过（55.864 秒）；Go vet 与差异空白检查通过。Web TypeScript 检查通过。
全量测试以受控 worker 并发运行，避免同时争用本机资源造成超时。

浏览器实测已确认原有 6 个供应商、183 条历史记录及分页、模型价格/封面、系统设置
和运营明细可读；实际点击运营导出的下载按钮得到 494 字节 CSV，包含表头和 3 条
数据，下载无失败且页面无告警。重启最新 Go 后，英文博客显示标题、作者、日期及标签，
中文 pSEO 页面可正常显示。管理文档搜索实际返回结果并可点击进入系统文档；支付概览
显示部署时区的完整自然月（2026-09-01 至 2026-09-30，Asia/Shanghai），订单页与筛选
正常加载。当前业务库没有支付订单，支付行为由独立测试库与模拟支付网关验证。
中英文系统文档均在浏览器中重新加载，显示当前八个外部 API 端点、Go 请求流程和
内容审核说明；已删除的旧 Agent / Responses 调用及自动提示词修剪说明不再出现。
这些页面检查没有进行付费媒体或真实支付交易。

本轮在独立 `fluxmedia_go_test_*` PostgreSQL 数据库和本地 Redis 上执行真实 Go HTTP / race
集成测试，没有清空业务库。相关回归覆盖：

- 私有脚本运行时 7 项真实 HTTP / Worker / QuickJS 测试通过（4.215 秒），覆盖真实
  队列、响应优先级、许可饱和/过期/断连回收、Worker 退出与超时恢复，以及 16 个已获
  许可的大响应同时排队。Go 诊断 client 定向 race 通过（1.951 秒），管理员权限、
  非零计数透传与运行时断线 503 的 PostgreSQL / race 测试通过（3.198 秒）。
  六种图片/视频操作的成功、准入拥堵、脚本失败和取消在实际 HTTP 测试中验证许可
  顺序与释放；真实图片 Worker 的拥堵恢复与发后故障不重提、原任务恢复及透明兜底
  PostgreSQL / race 回归通过（2.516 秒）。
- 图片实际创建任务到供应商 HTTP / Worker 完成的四种策略/容量场景与原路由、价格
  回归通过（4.295 秒）；供应商规范化错误的五类归因真实 Worker 回归通过：用户输入
  与审核拒绝不触发健康惩罚，供应商失败只计一次并冷却，私有错误详情不进入记录。
  该回归与响应许可恢复 PostgreSQL / race 测试通过（2.748 秒）。
- 积分包 Go 转发的 Shared 定向测试 4 个文件 / 22 项通过，Web 实际绑定和启动边界
  测试 3 个文件 / 8 项通过；覆盖真实 POST、套餐 GET 数组、会话转发、身份字段拒绝、
  严格数量/UUID 校验、Epay/Creem 返回契约，以及 409/400/503 保留为 UOL 错误。
  Go 的 5 项 `TestCreditPackage*` 实际 PostgreSQL / race 回归通过（5.799 秒）：Epay
  12 个并发请求只创建一个订单，Epay/Creem 的签名回调重复投递只入账一次；验证 Creem
  实际 HTTP 请求内容、隐藏套餐与身份拒绝，以及旧 Epay 订单返回信息恢复。
- 按金额充值的真实 PostgreSQL / race 回归通过（4.661 秒），覆盖创建/重试/过期、
  历史空有效期恢复、非法有效期拒绝和回调。实际 HTTPS 支付回包的签名、错误码和订单号
  校验回归通过（2.344 秒）；Go 普通测试和 vet 通过。未发起真实商户扣款。
- 支付管理读接口已验证部署时区的自然月/近七自然日、DST、分币种零值、按履约时间
  计算收入与按创建时间统计订单、一致性快照、绑定操作者/筛选/时区/页大小的双向游标、
  深页边界、精确邮箱及字面 `%` / `_` 搜索；`TestPaymentAdmin` PostgreSQL / race
  测试通过（4.340 秒），实际 Go 概览及订单输出均通过共享 strict Zod DTO。
- 文档搜索与签名 URL 有效期的实际 HTTP / PostgreSQL / race 测试通过（3.898 秒），
  覆盖 Fumadocs 数组、规范链接、中文匹配与分页限制、管理员边界、打包缺失错误，
  以及实际签名 `exp` 与无效 TTL 拒绝；见 `admin_search_integration_test.go` 与
  `storage_integration_test.go`。
- 最终独立复查补出的管理员头像遗漏由 `admin_user_profile_integration_test.go` 验证：
  设置/保留/清空、权限拒绝、无效输入、资料事务失败回滚及审计均通过独立 PostgreSQL
  / race 测试（4.412 秒）。本人资料 schema 不接受 null 清除，保持原有能力边界。
- 历史记录的账号隔离、管理员角色、签名分页、筛选、请求快照与安全字段，以及历史
  视频计费快照兼容；测试见 `history_migrated_integration_test.go`。
- 运营真实指标、留存、各明细类型、快照和微秒级分页、DST、统计 epoch 及历史订单兼容；
  测试见 `operations_migrated*_test.go`。Go 总览实际输出通过共享 strict Zod 契约校验。
- Redis 跨实例限流、运行时阈值更新、并发回退、会话/内部凭据、管理员范围和伪造 IP
  隔离；测试见 `rate_limit*_test.go`。
- 模型配置、图片输入/预览、后处理与扣费、尺寸绑定原子更新、CAS 和失败回滚；
  对应 Go PostgreSQL / race 测试与共享模型契约、UI 转发测试已执行。
- Web 的设置读取、限流适配、历史兼容 helper、管理员看板和运营 Action 已更新到 Go
  传输契约；Go 的 429/503/504 等稳定错误保留为页面可识别状态。

媒体计算运行时已完成三项本机真实 ONNX 推理和 Linux 容器依赖/推理检查，
`Dockerfile.media-processing-runtime` 专项镜像构建通过。生产统一镜像构建一次 Web、Go
与两个私有运行时，共享依赖层并使用 BuildKit 缓存；Compose 使用 digest 固定该镜像。
统一健康检查同时验证四个进程，运营 epoch 通过容器内回环 Go 接口初始化。Go backend 的 go-builder
目标实际构建通过，产物为 Go 1.26.6、CGO=0、linux/amd64；嵌入式设置定义与 YAML
解析依赖均包含在构建中。pruner 目标也构建通过，裁剪后的四份博客/pSEO 内容文件
逐一通过与仓库源文件的 SHA256 一致性检查。构建验证通过临时同版本官方 ECR
基础镜像绕过 Docker Hub 网络故障，仓库中的 Go 版本和发行版未变更。

新增脚本调度池后，`Dockerfile.api-upstream-script-runtime` 专项镜像再次实际构建通过，
frozen lock 安装 QuickJS 0.32.0，镜像包含 `pool.mjs`。无网络、无宿主端口的临时
容器以 UID 1001 运行，实际验证健康检查、私有接口鉴权、两个 Worker 的实时诊断、
请求与响应脚本计算，以及成功/脚本失败后的许可回收和重复释放。三个运行源码文件
与工作区 SHA256 一致；验证容器与镜像已清理。

以上不等同于已经发布生产，也不等同于已经向全部真实外部供应商发起媒体、邮件或支付
请求。测试和浏览器页面检查应与该文档的边界结果一起审阅。

## 本地入口

```bash
pnpm install --frozen-lockfile
make dev-backend                  # Go :8080，先迁移后监听
make dev-frontend                 # Next.js 页面 :3000
make dev-script-runtime           # 私有 QuickJS :8090
make dev-media-processing-runtime # 私有 ONNX / sharp :8091
make dev                         # 一次启动四个服务
make test-go
make test-go-integration
```

根 `pnpm dev` 也启动四个服务，并统一从仓库根 `.env.local`、`.env` 读取配置。
`quickjs-emscripten` 属于脚本运行时工作区依赖，必须在根目录安装 workspace，避免直接
运行未安装依赖的 `worker.mjs`。内部 token 必须在 Go 和相应私有运行时两端一致。

自定义 Go 集成测试数据库使用 `GO_BACKEND_TEST_DATABASE_URL`，只允许本机地址且库名
以 `fluxmedia_go_test_` 开头。通过 `scripts/with-root-env.mjs --exec` 启动测试可沿用
根环境的必要配置；不要把线上或开发业务 `DATABASE_URL` 当成清理型测试库。
