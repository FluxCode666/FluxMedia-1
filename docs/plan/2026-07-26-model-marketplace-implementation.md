# 模型广场与模型配置实施计划

> 本计划的规格来源是
> `docs/superpowers/specs/2026-07-26-model-marketplace-design.md`。实现时按任务顺序推进，
> 每个任务完成相关验证后单独提交。

状态：Task 1–11 已完成；Task 12 的文档、typecheck、lint 与 test 已完成，生产构建页面
数据收集和真实浏览器验收受本工作树缺少 `DATABASE_URL` 阻塞。

## 目标

把现有“模型计费”升级为按模型编辑的“模型配置”，新增公开 `/models` 模型广场、
模型详情弹窗、封面管理、展示开关和创作页预选，同时保证：

- 展示配置不改变 `/v1/models`、调度、套餐权限或实际扣费；
- 图像四档价格与视频每秒价格继续使用现有财务 schema；
- 所有读写先暴露为 UOL operation，Server Action 与 API Route 只做薄适配；
- 自定义封面由服务端校验、重编码和存储，不接受外部 URL；
- 首页和模型广场共享同一个公开展示目录。

## 实施时前置记录

以下条目记录开始实施时的基线与约束，不代表当前代码状态。

1. 先取得另一工作树“移除对话模型”的最终提交并合入当前基线。当前代码仍包含
   `conversation` 目录和文案，不能在本功能中重新引入或保留兼容字段。
2. 确认当前设计提交 `26b6be10` 在实施基线上；当前工作树是 detached HEAD，实际实施前
   按仓库单分支规则把已确认设计接回 `main` 的最新基线。
3. 保留未跟踪的 `.superpowers/` 草图目录，不暂存、不提交。
4. 当前工作树没有 `node_modules`；先安装锁文件指定的依赖，再执行聚焦检查。如果失败，
   先区分既有故障与本功能回归：

```bash
pnpm install --frozen-lockfile
pnpm --filter @repo/shared test
pnpm --filter @repo/web test
pnpm --filter @repo/shared typecheck
pnpm --filter @repo/web typecheck
```

## 全局实现约束

- TypeScript strict，禁止 `any`；外部输入均经 Zod 或显式类型收窄。
- 每个新文件、函数和组件都有简体中文职责与边界注释。
- 不把展示字段塞进 `imageCreditPricingSchema` 或视频价格 `Record`。
- 不新增数据库表迁移；展示配置与幂等回执复用 `system_setting` JSON。
- 模型资产 bucket 必须非空且与 avatars、generations bucket 互不相同；误配置时写入和匿名
  读取都 fail-closed，不能扩大私有 generations 访问。
- 不给模型配置 operation 增加 Agent/MCP 暴露，三个 operation 均为 `human-only`。
- 管理端 multipart 路由在解析文件前完成受信 Origin、会话和请求体大小检查。
- 正式 UI 只复用当前主题 token 与 `@repo/ui`，草图仅作为布局依据。
- 已知模型使用真实本地品牌图标；未知自定义模型使用中性图标，不猜测品牌。
- 每个任务使用 Conventional Commit，提交正文说明 WHY，不使用 `--no-verify`。

---

## Task 1：建立 DB-free 模型广场契约与纯函数

**Files**

- Create: `packages/shared/src/model-marketplace/contracts.ts`
- Create: `packages/shared/src/model-marketplace/catalog.ts`
- Create: `packages/shared/src/model-marketplace/contracts.test.ts`
- Create: `packages/shared/src/model-marketplace/catalog.test.ts`
- Modify: `packages/shared/package.json`

**接口与职责**

`contracts.ts` 是配置、管理 DTO、公开 DTO 和单条目更新输入的唯一 schema 来源：

- `MODEL_MARKETPLACE_CONFIG_VERSION = 2`；
- `modelMarketplaceConfigSchema` 与缺键默认工厂；
- `ModelMarketplaceEntry`、`ModelMarketplaceCoverRef`、写回执；
- `ModelConfigurationEntry` 管理端 DTO；
- `ModelConfigurationSnapshot` 管理读取 DTO，包含 entries、runtimeCatalogStatus 与根据真实
  Principal 计算的 canEdit；
- `ModelMarketplacePublicItem` 图像/视频判别联合 DTO；
- 公开 DTO 的模型字段固定为 `category + modelId`；视频使用定价配置键，时长、比例与
  分辨率只在详情字段展示，页面不再把路由笛卡尔积 ID 当作模型身份；
- `updateModelConfigurationEntryInputSchema`，含 `clientRequestId`、
  `expectedRevision`、图像完整四档价格或视频每秒价格，以及 `keep/remove/replace` 封面联合；
- `updateModelConfigurationEntryOutputSchema`，只返回 category、configKey、revision；
- 写入输入严格拒绝 bucket、key、URL、任意额外字段和对 `default` 的展示字段；
- 持久化配置只接受服务端生成的 bucket/key；管理和公开读取 DTO 只接受第一方
  `coverUrl` 并拒绝 bucket/key。

`catalog.ts` 只放 DB-free 规则：

- 图像配置键复用 `normalizeImagePricingModelId`；
- 视频完整 ID 解析为 family；
- 图像最低四档价格；
- 支持时长、比例、分辨率的排序与去重；
- 缺少显式配置时默认 visible；
- `default` 永不进入公开列表；
- 回执按 24 小时和 256 条上限稳定裁剪。

**测试步骤**

1. 先写失败测试，覆盖 strict schema、版本、默认值、200 字边界、revision 安全整数、
   继承价格 revision、`default` 限制和写回执清理。
2. 覆盖图像别名规范化、视频 family 解析、定价模型 ID、最低价格和缺键默认展示。
3. 执行：

```bash
pnpm --filter @repo/shared exec vitest run \
  src/model-marketplace/contracts.test.ts \
  src/model-marketplace/catalog.test.ts
pnpm --filter @repo/shared typecheck
```

4. 在 `packages/shared/package.json` 增加 `./model-marketplace` 子路径导出，Web 端禁止从
   shared 内部相对路径导入。

**Commit**

```text
feat(models): 定义模型广场共享契约

把展示配置、公开 DTO 与模型聚合规则收敛为 DB-free 契约，避免管理端、UOL 和营销页各自解释模型身份。
```

---

## Task 2：注册系统设置与 UOL operation

**Files**

- Modify: `packages/shared/src/system-settings/definitions.ts`
- Modify: `packages/shared/src/system-settings/defaults.test.ts`
- Modify: `packages/shared/src/system-settings/index.test.ts`
- Create: `packages/shared/src/uol/operations/model-marketplace.ts`
- Create: `packages/shared/src/uol/operations/model-marketplace.test.ts`
- Modify: `packages/shared/src/uol/operations/index.ts`
- Modify: `packages/shared/src/uol/operations/system-settings.ts`
- Modify: `packages/shared/src/uol/operations/system-settings-model-pricing.test.ts`

**设置定义**

在 `SettingKey` 与 `SYSTEM_SETTING_DEFINITIONS` 中增加：

- `MODEL_MARKETPLACE_CONFIG`：`json`、版本 2 空配置默认值、
  `managedByDedicatedOperation: true`；
- `MODEL_MARKETPLACE_ASSETS_BUCKET_NAME`：`string`，默认 `model-marketplace`，归入
  storage 分类。

默认初始化插入缺失行，并迁移旧图像 `default` 价格键；模型广场 v1 JSON 由严格解析器兼容
升级为 v2，因此无需手写 SQL 迁移。通用 settings 更新与 env 同步继续拒绝
`MODEL_MARKETPLACE_CONFIG`。

**UOL 注册项**

在 `model-marketplace.ts` 注册三个 stub，由 Web late binding 注入 execute：

1. `settings.getModelConfiguration`
   - domain: `system-settings`
   - access: `admin`
   - `readOnly: true`、自然幂等、`human-only`
2. `settings.updateModelConfigurationEntry`
   - domain: `system-settings`
   - access: `{ kind: "roles", roles: ["super_admin"] }`，只允许真实用户 Principal，
     不允许 system Principal 代写
   - `readOnly: false`、`destructive: true`
   - required idempotency：`clientRequestId`、`per-user`
   - sideEffects：`storage`、`cache`、`audit`
3. `modelMarketplace.listPublicModels`
   - domain: `external-api`
   - access: `system`
   - `readOnly: true`、自然幂等、`human-only`

旧 `settings.getModelPricing` 暂时保留，因为后端池管理页仍读取全局价格。旧的全快照
`settings.updateModelPricing` 在新单条目保存完成接线后删除，防止存在两个管理员写入口。

**测试步骤**

1. 先写 operation 元数据和 schema 失败测试。
2. 断言普通用户、普通管理员、system Principal 均不能执行真实超级管理员写操作。
3. 断言公开与管理输出 strict 拒绝 bucket、key 和未知字段。
4. 执行：

```bash
pnpm --filter @repo/shared exec vitest run \
  src/system-settings/defaults.test.ts \
  src/system-settings/index.test.ts \
  src/uol/operations/model-marketplace.test.ts \
  src/uol/operations/system-settings-model-pricing.test.ts
pnpm --filter @repo/shared typecheck
```

**Commit**

```text
feat(settings): 注册模型广场配置接口

先把展示配置和单模型读写固化为 UOL 契约，并让通用设置入口无法绕过专用校验。
```

---

## Task 3：实现封面处理、事务仓储与幂等保存内核

**Files**

- Create: `apps/web/src/features/model-configuration/cover-image.ts`
- Create: `apps/web/src/features/model-configuration/cover-image.test.ts`
- Create: `apps/web/src/features/model-configuration/catalog.ts`
- Create: `apps/web/src/features/model-configuration/catalog.test.ts`
- Create: `apps/web/src/features/model-configuration/read-service.ts`
- Create: `apps/web/src/features/model-configuration/read-service.test.ts`
- Create: `apps/web/src/features/model-configuration/service-core.ts`
- Create: `apps/web/src/features/model-configuration/service-core.test.ts`
- Create: `apps/web/src/features/model-configuration/repository.ts`
- Create: `apps/web/src/features/model-configuration/service.ts`

**封面处理**

`cover-image.ts` 接受 `Uint8Array`，不信任文件名或浏览器 MIME：

- 原始字节最多 5 MB；
- Sharp `failOn: "warning"`，解码像素上限 40,000,000；
- 只接受实际解码为 JPEG、PNG、WebP 的静态图片；
- 显式拒绝多页或动画 WebP；
- 自动旋转、中心裁为 3:2、最长输出 1200×800 且不放大小图；
- 移除元数据并输出 WebP quality 82；
- 返回最终字节、SHA-256 和固定 `image/webp`。

对象 key 使用 category、规范 configKey 的哈希和最终内容哈希，不包含原模型 ID、文件名或
路径片段。测试用 Sharp 在内存生成输入，不提交大体积二进制 fixture。

**服务边界**

`catalog.ts` 与 `read-service.ts` 实现管理清单的唯一装配路径：

- 稳定合并内置图像/视频、已持久化价格键和当前运行时目录；
- 运行时目录读取失败时返回“内置 ∪ 已持久化”以及明确的 runtime-unavailable 标志，
  仍允许管理员读取和保存这些条目；
- 配置 JSON 或完整价格矩阵脏值时显式失败，不用默认值静默覆盖；
- 资产 bucket 非法或与 avatars/generations 冲突时显式失败，不执行任何存储写入；
- 保存校验复用同一清单构建器，不能把公开目录的 `not_ready` 策略用于管理写入。
- 运行时额外图像模型没有显式价格时，DTO 标记 `pricingSource: "unconfigured"`，不携带
  价格或 minimumCredits；管理员必须填写完整四档价格后才能保存为可计费模型。

`service-core.ts` 只依赖可注入端口，保持 DB-free：

- repository transaction：初始化并按固定顺序锁定展示设置和目标价格行；
- storage：put/get/delete；
- runtime catalog loader；
- cache invalidator、logger、clock、hash 与 ID 工厂。

`repository.ts` 使用 Drizzle 实现端口。事务内完成：

1. 缺行时 `onConflictDoNothing` 补默认行，再 `FOR UPDATE`；
2. 严格解析展示配置与完整价格矩阵，脏值显式失败；
3. 用稳定 JSON 数组编码 actorUserId 与 clientRequestId 后计算 SHA-256 回执键，避免裸字符串
   拼接歧义；requestHash 覆盖除 clientRequestId 外的全部规范输入、expectedRevision 和最终
   WebP 内容哈希；
4. 查找回执；
5. 同键同 requestHash 返回原 category/configKey/resultingRevision，不再写存储或审计；
6. 同键不同载荷抛 `idempotency_conflict`；
7. 首次请求校验 expectedRevision；冲突时不覆盖；
8. `replace` 才写内容哈希对象；`remove` 若存在旧封面，先在锁内确认旧对象可读取或已
   明确不存在，存储基础设施错误则回滚并保留旧引用；随后合并目标条目并重新执行完整
   财务 schema；
9. 原子更新价格、展示配置、回执和 `admin_audit_log`；审计不含图片字节、存储凭据或
   原始错误对象；
10. 提交后失效设置缓存；缓存失效失败记录结构化告警，数据库提交仍是真相；
11. 数据库失败后的新对象清理，以及提交后的旧对象清理，都通过一个短清理事务重新锁定
    展示配置行并复核引用；删除期间保持该锁，避免并发保存刚引用同一内容哈希后被误删；
12. 旧对象物理删除失败只留下无引用孤儿并记录结构化告警，不回滚已生效的新引用或默认
    封面状态；`remove` 的存储可用性预检失败则整个操作失败且旧引用保持不变。

数据库实现只在底层开启一次事务，UOL binding 和传输层不得再包事务。

**测试步骤**

1. 覆盖三种封面操作、非法格式、伪 MIME、损坏图片、5 MB、像素炸弹与 WebP 输出。
2. 使用内存 repository/storage 覆盖：
   - 图像、视频单条更新不修改其他项；
   - 管理清单正常合并以及运行时目录失败时降级为内置与已持久化条目；
   - 完整财务 schema 再校验；
   - revision 冲突；
   - 未定价图像首次保存后成为显式价格，revision 冲突仍不覆盖；
   - 同请求重放；
   - 请求键复用不同载荷；
   - put 失败、remove 存储预检失败、事务失败、新旧对象清理失败；
   - 两个模型并发使用同一封面内容时，清理不会删除仍被引用的对象；
   - 审计只写一次；
   - 回执过期或超量后旧 revision 仍阻止重复副作用。
3. 聚焦验证：

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/model-configuration/cover-image.test.ts \
  src/features/model-configuration/catalog.test.ts \
  src/features/model-configuration/read-service.test.ts \
  src/features/model-configuration/service-core.test.ts
pnpm --filter @repo/web typecheck
```

**Commit**

```text
feat(models): 实现模型配置事务与封面存储

用单条目乐观锁、请求回执和内容寻址对象保证价格、展示信息、封面与审计一致提交。
```

---

## Task 4：构建公开目录并完成 UOL late binding

**Files**

- Create: `apps/web/src/features/model-marketplace/catalog.ts`
- Create: `apps/web/src/features/model-marketplace/catalog.test.ts`
- Create: `apps/web/src/features/model-marketplace/assets.ts`
- Create: `apps/web/src/features/model-marketplace/assets.test.ts`
- Create: `apps/web/src/features/model-marketplace/service.ts`
- Create: `apps/web/src/features/model-marketplace/service.test.ts`
- Create: `apps/web/src/server/model-marketplace-binding.ts`
- Create: `apps/web/src/server/model-marketplace-binding.test.ts`
- Create: `apps/web/public/model-marketplace/default-image.webp`
- Create: `apps/web/public/model-marketplace/default-video.webp`
- Create: `apps/web/public/model-marketplace/brands/openai.svg`
- Create: `apps/web/public/model-marketplace/brands/google.svg`
- Create: `apps/web/public/model-marketplace/brands/kling.svg`
- Create: `apps/web/public/model-marketplace/brands/xai.svg`
- Create: `apps/web/public/model-marketplace/brands/generic.svg`
- Create: `docs/model-marketplace-assets.md`
- Modify: `apps/web/src/server/uol-bindings.ts`

**目录装配**

`service.ts` 并行读取：

- `loadPlatformModelCatalog()` 的运行时可达图像与视频 ID；
- 两个现有价格设置；
- `MODEL_MARKETPLACE_CONFIG`；
- 模型资产 bucket 设置。

`catalog.ts` 纯构建器完成：

- 运行时模型与 visible 配置取交集；
- 图像按规范 configKey 读取四档价格；没有显式条目时标记为未配置并从公开目录排除；
- 视频完整 ID 按 family 聚合为一张卡，公开 ID 固定使用定价配置键；
- 从真实完整 ID 归纳支持时长、比例和分辨率；
- 计算最低价格，不持久化派生值；
- 应用内置简介、默认封面和品牌 `iconKey`；
- `iconKey` 固定为 `openai | google | kling | xai | generic`：GPT Image/Sora 映射
  OpenAI，Nano Banana/Veo 映射 Google，Kling 映射 Kling，Grok 映射 xAI；未知自定义
  ID 稳定返回 `generic`，不冒用品牌；
- 输出只保留第一方 coverUrl 与公开 DTO 字段。

本 Task 在任何公开 DTO 引用资源前先落地默认封面和品牌资产。`assets.ts` 是 iconKey 到本地
路径的唯一映射；默认封面使用项目拥有或已获许可的 3:2 WebP，品牌 SVG 来自官方品牌资源
或明确许可来源。`docs/model-marketplace-assets.md` 记录精确来源、版本、许可和获取日期；
不依赖第三方 CDN，不新增图标依赖包。

运行时目录失败、配置严格解析失败或价格事实源失败时 operation 抛稳定 `not_ready`，页面层
映射为 unavailable；全部模型显式关闭时正常返回空数组。

绑定层必须把上述三类依赖故障显式收窄为 `OperationError("not_ready", ...)`；不能依赖
`invokeOperation` 把普通异常映射为 `internal_error`。管理读取则绑定 Task 3 的降级服务，
与公开读取的失败策略保持分离。

**绑定与旧接口收敛**

`model-marketplace-binding.ts` 绑定三个新 operation：管理读取、单条目保存、公开读取。
旧 `externalApi.getPlatformModelCatalog` 此时仍被首页使用，暂时保留到 Task 11；Task 4 的测试
必须证明新旧 operation 读取同一运行时事实源，但新 operation 额外应用展示配置与价格。

**测试步骤**

1. 覆盖 visible false、缺项默认 true、运行时不可达、视频变体归并和定价模型 ID。
2. 断言 custom true 不能凭空新增模型，`default` 不能进入目录。
3. 分别让运行时目录、价格设置和展示配置失败，断言 operation 返回稳定 `not_ready`；
   管理读取的运行时失败仍返回可编辑清单。
4. 资产契约测试断言全部 iconKey 都有本地映射、两个默认封面解码尺寸为 3:2 WebP、SVG
   不含 script、事件属性或外部 URL，未知模型只使用 generic。
5. 经真实 `bindExecute + invokeOperation` 验证 strict DTO，不包含 bucket、key、后端成员、
   凭据或健康错误。
6. 执行：

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/model-marketplace/catalog.test.ts \
  src/features/model-marketplace/assets.test.ts \
  src/features/model-marketplace/service.test.ts \
  src/server/model-marketplace-binding.test.ts
pnpm --filter @repo/shared exec vitest run \
  src/uol/operations/model-marketplace.test.ts
pnpm --filter @repo/web typecheck
```

**Commit**

```text
feat(models): 提供模型广场公开目录与资产

装配运行时可达性、展示配置和价格的安全交集，并让所有公开资源在 DTO 引用前可用。
```

---

## Task 5：增加管理传输层与公共模型资产读取

**Files**

- Create: `apps/web/src/features/model-configuration/actions.ts`
- Create: `apps/web/src/features/model-configuration/actions.test.ts`
- Create: `apps/web/src/features/model-configuration/request-origin.ts`
- Create: `apps/web/src/features/model-configuration/request-origin.test.ts`
- Create: `apps/web/src/features/model-configuration/bounded-multipart.ts`
- Create: `apps/web/src/features/model-configuration/bounded-multipart.test.ts`
- Create: `apps/web/src/app/api/admin/model-configuration/route.ts`
- Create: `apps/web/src/app/api/admin/model-configuration/route.test.ts`
- Modify: `apps/web/src/app/api/storage/[bucket]/[...key]/route.ts`
- Modify: `apps/web/src/app/api/storage/[bucket]/[...key]/route.test.ts`

**读取 Action**

应用内 Server Action 调 `ensureUolInitialized()`，从真实会话构造 Principal，再调用
`settings.getModelConfiguration`。Action 不读取数据库、不合并价格、不构造封面 URL。

**multipart 保存 Route**

POST `/api/admin/model-configuration` 固定顺序：

1. 用现有可信 Origin 规则拒绝缺失、null、非法和跨站 Origin；
2. `Content-Length` 存在时先拒绝非法值和超过 6 MiB 的声明值；缺失或伪造偏小不能视为
   安全依据；
3. Better Auth 读取会话并提前要求真实 `super_admin`，避免未授权用户消耗 multipart
   解析资源；UOL 的 roles 权限仍做最终授权，早期预检不能代替网关；
4. 使用 `ReadableStream` 逐块累计真实正文，超过 6 MiB 立即取消读取；只把通过上限的
   有界字节交给平台 `formData()` 解析，不对原始无界 Request 直接调用 `formData()`；
5. 解析 category、configKey、expectedRevision、clientRequestId、价格、展示字段、
   coverChange 和最多一个 File；拒绝未知字段、重复标量字段和额外文件，不能用
   `FormData.get()` 静默忽略重复输入；
6. File.size 再校验 5 MB，并转换为 `Uint8Array`；
7. 调 `ensureUolInitialized()`，构造真实 user Principal，再调用
   `settings.updateModelConfigurationEntry`；
8. 只按 `OperationError.code/httpStatus` 编码稳定 JSON，不回传内部异常。

同一用户保存动作在客户端只生成一次 UUID；网络自动重试复用该 UUID，修改草稿或再次主动
保存生成新 UUID。

**公共资产读取**

存储 Route 的 bucket 配置增加模型资产 bucket：

- avatars 与模型资产 bucket 允许匿名读取；generations 保持签名或所属权校验；
- 每次从运行时设置读取三个 bucket 并验证非空且互不相同；冲突时不把模型资产规则应用到
  任一 bucket，返回稳定配置错误；
- 模型资产 bucket 只允许 `category/configHash/contentHash.webp` 形式的内容哈希 key；
  其他扩展、层级和非法路径拒绝；
- 返回 `image/webp`、`nosniff` 和长期 immutable 缓存；
- 不扩大 generations 或任意自定义 bucket 的读取权限。

公开目录从已经严格校验的资产 bucket/key 逐段 URL 编码后构造本站相对 `coverUrl`；不把
运行时 bucket 塞进客户端环境变量，也不误用只在模块加载时读取 avatars 的
`isPublicBucket()` 判断。

**测试步骤**

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/model-configuration/actions.test.ts \
  src/features/model-configuration/request-origin.test.ts \
  src/features/model-configuration/bounded-multipart.test.ts \
  src/app/api/admin/model-configuration/route.test.ts \
  'src/app/api/storage/[bucket]/[...key]/route.test.ts'
pnpm --filter @repo/web typecheck
```

重点断言 Origin 和鉴权失败发生在正文读取及 UOL 调用之前；同时覆盖缺失长度、非法长度、
伪造偏小长度、chunked 输入、未知/重复字段、多文件、多字段总正文超过 6 MiB，以及模型
资产 bucket 与 generations/avatars 冲突时保持 fail-closed。

**Commit**

```text
feat(admin): 接入模型配置安全传输层

用薄 multipart 适配器承接封面字节，并保持鉴权、幂等、存储和错误语义集中在 UOL 服务。
```

---

## Task 6：重构管理端为模型配置列表与编辑弹窗

**Files**

- Delete: `apps/web/src/features/model-pricing/index.ts`
- Delete: `apps/web/src/features/model-pricing/model-pricing-panel.tsx`
- Create: `apps/web/src/features/model-configuration/index.ts`
- Create: `apps/web/src/features/model-configuration/model-configuration-panel.tsx`
- Create: `apps/web/src/features/model-configuration/model-configuration-table.tsx`
- Create: `apps/web/src/features/model-configuration/model-configuration-dialog.tsx`
- Create: `apps/web/src/features/model-configuration/model-configuration-draft.ts`
- Create: `apps/web/src/features/model-configuration/model-configuration-draft.test.ts`
- Create: `apps/web/src/features/model-configuration/model-configuration-view-model.ts`
- Create: `apps/web/src/features/model-configuration/model-configuration-view-model.test.ts`
- Create: `apps/web/src/features/model-configuration/model-cover-field.tsx`
- Create: `apps/web/src/features/model-marketplace/model-brand-icon.tsx`
- Modify: `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/admin-settings-tabs.tsx`

**列表**

把内部 tab 值与标题从 `model-pricing` 改为 `model-configuration` / “模型配置”。列表列为：

- 3:2 封面缩略图；
- 品牌图标与模型 ID；
- 图像或视频类型；
- 已展示、已隐藏或未配置价格；
- 实时计算的最低价格；
- “编辑”按钮。

管理读取 DTO 的 `canEdit` 为 false 时，操作文案改为“查看”，Dialog 全部只读且不渲染保存、
上传或移除操作；只有真实 super_admin 显示“编辑”。

支持 ID 搜索和图像/视频筛选；运行时目录不可用时展示提示，但仍列出内置模型和已持久化
价格模型。运行时新发现但未定价的图像模型仍进入管理列表，并显示“未配置价格”。

**编辑 Dialog**

- 品牌图标和模型 ID 只读；
- 图像显示四档价格，视频显示每秒价格；
- 所有真实模型显示 Switch、最多 200 字简介、字符计数和封面选择/移除；
- 未定价图像价格输入初始为空，保存时必须一次提交完整四档正数价格；
- 本地预览只保留到保存或取消，并及时 `URL.revokeObjectURL`；
- 保存时组装 FormData 请求 Task 5 Route；
- revision 冲突保留草稿并提供“重新加载”；
- 失败不把未保存封面伪装成已生效。

不要修改被后端池分组页复用的 image/video pricing editor；本 Dialog 用专用、较小的价格输入
组件，避免把模型广场控件带入分组覆盖界面。

品牌图标与默认封面直接复用 Task 4 的资产契约。自定义封面或默认封面加载失败时，缩略图
保持固定 3:2 容器并在单次错误后回退本地默认封面，不修改持久化配置、不无限重试。

**测试步骤**

1. 纯函数测试草稿创建、价格解析、最低价格、FormData 字段、请求 UUID 生命周期和冲突合并。
2. 用纯 view-model 测试列表搜索、类型筛选、稳定排序、未配置价格、canEdit 只读分支、
   Dialog 字段条件和封面失败回退；Web Vitest 是 Node 环境，不留下“若环境支持”的不确定
   分支。
3. 执行：

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/model-configuration/model-configuration-draft.test.ts \
  src/features/model-configuration/model-configuration-view-model.test.ts
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web lint
```

4. 本 Task 当场做聚焦浏览器验收：列表搜索/筛选、Dialog 条件字段、预览取消、保存成功、
   revision 冲突保留草稿和自定义封面 404 回退；不把全部 UI 风险推迟到最终验收。

**Commit**

```text
feat(admin): 重构模型配置列表与编辑弹窗

把全量价格快照编辑收敛为单模型草稿，降低误覆盖风险并在同一入口管理展示信息。
```

---

## Task 7：收敛旧模型价格写入口

**Files**

- Modify: `packages/shared/src/system-settings/definitions.ts`
- Modify: `packages/shared/src/system-settings/actions/index.ts`
- Modify: `packages/shared/src/system-settings/index.ts`
- Modify: `packages/shared/src/system-settings/index.test.ts`
- Modify: `packages/shared/src/uol/operations/system-settings.ts`
- Modify: `packages/shared/src/uol/operations/system-settings-model-pricing.test.ts`

Task 6 已让管理端完全切到单条目写入。先用 `rg` 确认除旧 Action/UOL 及其测试外无调用方，
再删除全快照写 Action、`settings.updateModelPricing` 和 `setGlobalModelPricing`；后端池仍使用的
`settings.getModelPricing`、只读 Action 和底层读取函数必须保留。同步把两个价格设置定义中
指向“模型计费”的说明改为“模型配置”。

**测试步骤**

```bash
pnpm --filter @repo/shared exec vitest run \
  src/system-settings/index.test.ts \
  src/uol/operations/system-settings-model-pricing.test.ts
pnpm --filter @repo/shared typecheck
rg -n "settings\.updateModelPricing|setGlobalModelPricing|updateGlobalModelPricingAction" \
  apps packages
```

最后一条 `rg` 必须无输出；`settings.getModelPricing` 仍应存在并有测试覆盖。

**Commit**

```text
refactor(settings): 收敛模型价格写入口

在管理端完成单模型接线后删除全快照写路径，避免旧客户端继续绕过 revision 与展示配置事务。
```

---

## Task 8：实现“立即使用”的安全模型预选与登录回跳

**Files**

- Create: `apps/web/src/features/image-generation/model-preselection.ts`
- Create: `apps/web/src/features/image-generation/model-preselection.test.ts`
- Modify: `apps/web/src/features/image-generation/components/create-page-client.tsx`
- Modify: `apps/web/src/features/image-generation/components/video-create-panel.tsx`
- Create: `apps/web/src/features/image-generation/components/video-create-preselection.test.ts`
- Create: `apps/web/src/features/auth/safe-callback-url.ts`
- Create: `apps/web/src/features/auth/safe-callback-url.test.ts`
- Modify: `apps/web/src/proxy.ts`
- Modify: `apps/web/src/features/auth/components/sign-in-form.tsx`
- Modify: `apps/web/src/features/auth/components/sign-up-form.tsx`
- Modify: `apps/web/src/app/[locale]/(auth)/sign-in/page.tsx`
- Modify: `apps/web/src/app/[locale]/(auth)/sign-up/page.tsx`

**查询契约与纯函数**

使用显式参数：

- 图像：`/dashboard/generate?category=image&model=<id>`；
- 视频：`/dashboard/create?category=video&model=<完整id>`。

`model-preselection.ts` 拆出四个 DB-free 纯函数：

- `parseModelPreselectionIntent`：只接受 image/video 与最多 160 字的非空模型 ID；
- `resolveAuthorizedImageSelection`：只从当前用户已有 `unifiedCatalogSelections` 中选择，
  同时要求 generate 能力，顺序为当前组、`isDefault` 组、首个可生成组；
- `resolveVideoInitialSelection`：用 `resolveFireflyVideoModel` 验证静态目录合法性，最终调用
  仍由服务端重新执行用户、后端和模型校验；
- `removePreselectionParams`：只移除 category/model，保留 ref、mode 等无关查询参数。

**创作页消费**

- `/dashboard/generate` 在合法 image 意图下固定进入 image 模式，匹配授权模型后才更新选择；
- `/dashboard/create` 在合法 video 意图下设置 `activeMode="video"`，并禁止 localStorage 的旧
  mode 在本次初始化中覆盖；
- `VideoCreatePanel` 只消费一次 initial model，按解析结果设置 family、时长、比例和分辨率；
- 无授权、非法或已移除模型提示一次并保留安全默认值；无论合法与否都只消费一次；
- 查询参数清理与既有 ref/sendRef effect 使用同一合并函数或顺序协调，不能用两个基于旧
  `searchParams` 的 `router.replace` 互相带回已删除参数。

**登录回跳**

未登录用户访问上述受保护 URL 时必须保留模型意图。`safe-callback-url.ts` 只接受无 locale
或当前 locale 前缀下 `/dashboard` 开头的站内绝对路径与其查询参数，并统一输出带当前 locale
前缀的路径；拒绝绝对 URL、协议相对 URL、错误 locale、反斜杠、控制字符和非 dashboard
路径。proxy 把 pathname 与 search 一起写入 callbackUrl；登录和注册页面服务端收窄后传给
表单，邮箱与 Google 流程共用同一个安全 callback URL，登录/注册互链继续携带它。非法
callback 统一回退当前 locale 的 `/dashboard`。

**测试步骤**

1. 覆盖参数长度、未知 category、编码 ID、跨组优先级、generate 能力、无授权回退和只应用
   一次。
2. 覆盖 video 切 tab、localStorage 不覆盖、静态合法性、服务端最终拒绝提示和非法回退。
3. 覆盖保留无关参数、与 ref/sendRef 同时出现、非法模型只提示一次和刷新不重复覆盖。
4. 覆盖 callback 开放重定向攻击、无前缀和当前/错误 locale、完整模型 query、邮箱/Google
   与登录注册互链。
5. 执行：

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/image-generation/model-preselection.test.ts \
  src/features/image-generation/components/video-create-preselection.test.ts \
  src/features/auth/safe-callback-url.test.ts
pnpm --filter @repo/web typecheck
```

**Commit**

```text
feat(generate): 支持模型广场安全预选

把营销页模型选择作为一次性意图，在登录回跳和创作页中保留它，并由现有权限事实重新校验。
```

---

## Task 9：实现公开模型广场与站点发现入口

**Files**

- Create: `apps/web/src/features/model-marketplace/model-card.tsx`
- Create: `apps/web/src/features/model-marketplace/model-detail-dialog.tsx`
- Create: `apps/web/src/features/model-marketplace/model-marketplace-browser.tsx`
- Create: `apps/web/src/features/model-marketplace/model-marketplace-browser.test.ts`
- Create: `apps/web/src/features/model-marketplace/page-data.ts`
- Create: `apps/web/src/features/model-marketplace/page-data.test.ts`
- Create: `apps/web/src/features/model-marketplace/model-marketplace-metadata.ts`
- Create: `apps/web/src/features/model-marketplace/model-marketplace-metadata.test.ts`
- Create: `apps/web/src/features/model-marketplace/i18n-contract.test.ts`
- Create: `apps/web/src/app/[locale]/(marketing)/models/page.tsx`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`
- Modify: `packages/shared/src/config/nav.ts`
- Modify: `packages/shared/src/config/nav.test.ts`
- Modify: `apps/web/src/features/marketing/components/footer.tsx`
- Create: `apps/web/src/features/marketing/components/footer.test.ts`
- Modify: `apps/web/src/features/marketing/homepage/homepage-footer.tsx`
- Create: `apps/web/src/features/marketing/homepage/homepage-footer.test.ts`
- Modify: `apps/web/src/app/sitemap.ts`
- Create: `apps/web/src/app/sitemap.test.ts`

**页面数据**

`page-data.ts` 只调用 `ensureUolInitialized()` 与
`modelMarketplace.listPublicModels`，把错误收窄为：

- `{status: "ready", models}`；
- `{status: "unavailable"}`。

它不复用首页会话、SLA 和角色装配器，避免 `/models` 为无关数据触发额外查询。

**页面与卡片**

- 新增本地化营销路由 `/models`，复用营销 Header 与 Footer；
- 页面显式 `export const dynamic = "force-dynamic"`，禁止 Full Route Cache 固化运行时目录
  或展示开关；
- Server Component 输出标题、说明、ready-empty/unavailable；
- Client Component 只负责搜索、类型筛选、复制反馈和详情 Dialog；
- 桌面为筛选侧栏加三列卡片，中等宽度两列，移动端一列并用 Sheet 收纳筛选；
- 卡片顺序严格为 3:2 封面、类型、图标 + ID + 紧随其后的仅图标复制按钮、最低价格、
  整行“查看详情”；
- 长 ID 省略并用 Tooltip 显示完整值，复制始终使用公开模型 ID；
- 详情 Dialog 展示简介、完整价格、支持参数和“立即使用此模型”；
- Dialog 遵循焦点转移、Esc、关闭后回焦，移动端使用现有响应式 Dialog/Sheet 形态。
- 封面保持固定 3:2 容器；自定义封面 404 或解码失败时只回退一次对应类别的本地默认
  封面，不修改持久化配置。

新增 `ModelMarketplace` i18n namespace，英文与中文 key 结构同步。SEO metadata 包含页面 title、
description、canonical 和双语 alternates；专用 metadata 纯函数与测试锁定 `/en/models`、
`/zh/models` 及当前语言 canonical。

**站点发现入口**

- `mainNav` 的 Models 从 `/#models` 改为 `/models`，同时覆盖桌面和移动 Header；
- 普通 Footer 与首页 Footer 都增加 `/models`；普通 Footer 的站内链接改用
  `@/i18n/routing` 的 `Link`，`mailto:` 等外部协议仍使用 `<a>`；
- sitemap 静态路径增加 `/models`，生成中英文 URL；
- 首页此时继续保留 `id="models"` 和旧数据读取，真正目录迁移在 Task 10。

**测试步骤**

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/model-marketplace/model-marketplace-browser.test.ts \
  src/features/model-marketplace/page-data.test.ts \
  src/features/model-marketplace/model-marketplace-metadata.test.ts \
  src/features/model-marketplace/i18n-contract.test.ts \
  src/features/marketing/components/footer.test.ts \
  src/features/marketing/homepage/homepage-footer.test.ts \
  src/app/sitemap.test.ts
pnpm --filter @repo/shared exec vitest run src/config/nav.test.ts
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web lint
```

随后做聚焦浏览器验收：复制成功/失败、详情焦点与 Esc、移动 Sheet、封面失败回退、已登录
CTA 预选和未登录邮箱/Google 回跳。英文与中文模型广场各验证一次；管理后台沿用当前中文
界面，不在本功能中扩展为双语后台。

**Commit**

```text
feat(marketing): 发布公开模型广场

以当前营销主题发布可搜索的模型卡片、详情弹窗和完整站点入口，并只消费公开 UOL DTO。
```

---

## Task 10：让首页切换到模型广场目录

**Files**

- Modify: `apps/web/src/features/marketing/homepage/homepage-page-data.ts`
- Modify: `apps/web/src/features/marketing/homepage/homepage-page-data.test.ts`
- Modify: `apps/web/src/features/marketing/homepage/homepage-model-catalog.tsx`
- Modify: `apps/web/src/features/marketing/homepage/homepage-content.tsx`
- Create: `apps/web/src/features/marketing/homepage/homepage-content.test.ts`
- Modify: `apps/web/src/features/marketing/homepage/homepage-integration.tsx`
- Modify: `apps/web/src/features/marketing/homepage/integration-example.ts`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/zh.json`

**首页数据**

首页把原最小平台目录 operation 替换为 `modelMarketplace.listPublicModels`，然后只投影图像模型给
现有首页区块和快速集成示例。不要在首页展示层再次隐藏 Firefly 或绕过 visible 结果。

首页保持当前布局，不复用模型广场卡片；可增加“查看全部模型”链接，但传给快速集成的图像
列表保持完整，不能因首页视觉截断而改变示例模型选择。

旧 `externalApi.getPlatformModelCatalog` 在本 Task 暂时保留但已无首页调用方，下一 Task 再单独
删除，保证目录迁移与清理回归可分别定位。首页继续保留 `id="models"` 兼容历史外链；更新
FAQ，不再声称“首页只展示图像是因为没有视频广场”，并删除已下线的对话模型文案。

**测试步骤**

```bash
pnpm --filter @repo/web exec vitest run \
  src/features/marketing/homepage/homepage-page-data.test.ts \
  src/features/marketing/homepage/integration-example.test.ts \
  src/features/marketing/homepage/homepage-content.test.ts
pnpm --filter @repo/web typecheck
```

测试锁定 ready-empty 与 unavailable 不混淆、首页保留 `id="models"` 和“查看全部模型”、视觉
预览截断不改变快速集成收到的完整图像目录。额外回归：visible false 只影响首页与
`/models`；`/v1/models` 及创作目录测试结果不变。

**Commit**

```text
feat(homepage): 同步模型广场展示目录

让首页公开预览与模型广场共用展示事实，同时保持外部 API 与创作权限目录完全独立。
```

---

## Task 11：删除旧公开目录 operation 并拆分 SLA binding

**Files**

- Create: `apps/web/src/server/homepage-reliability-binding.ts`
- Delete: `apps/web/src/server/platform-model-catalog-binding.ts`
- Modify: `apps/web/src/server/uol-bindings.ts`
- Modify: `apps/web/src/features/external-api/platform-model-catalog-service.test.ts`
- Delete: `packages/shared/src/uol/operations/external-api-platform-model-catalog.ts`
- Delete: `packages/shared/src/uol/operations/external-api-platform-model-catalog.test.ts`
- Modify: `packages/shared/src/uol/operations/index.ts`
- Modify: `packages/shared/src/mcp/tool-factory.test.ts`
- Modify: `apps/web/src/app/api/mcp/user/route.test.ts`
- Modify: `apps/web/src/app/api/mcp/admin/route.test.ts`

首页完成迁移后，删除 `externalApi.getPlatformModelCatalog` 的注册、契约和绑定。原 binding 中
仍有职责的首页 SLA execute 迁入 `homepage-reliability-binding.ts`，并由启动绑定入口继续加载。
MCP 工厂与两条 MCP Route 的隔离断言全部迁到 `modelMarketplace.listPublicModels`，保证新
system-only/human-only operation 不会出现在 Admin 或 User MCP。

**测试步骤**

```bash
pnpm --filter @repo/shared exec vitest run \
  src/mcp/tool-factory.test.ts \
  src/uol/operations/homepage-reliability.test.ts
pnpm --filter @repo/web exec vitest run \
  src/features/external-api/platform-model-catalog-service.test.ts \
  src/app/api/mcp/user/route.test.ts \
  src/app/api/mcp/admin/route.test.ts
pnpm --filter @repo/shared typecheck
pnpm --filter @repo/web typecheck
rg -n "externalApi\.getPlatformModelCatalog|external-api-platform-model-catalog|platform-model-catalog-binding" \
  apps packages
```

最后一条 `rg` 必须无输出；平台运行时目录 service 本身继续保留，供模型广场和外部 API
读取同一运行时事实。

**Commit**

```text
refactor(uol): 删除旧公开模型目录接口

在首页迁移完成后移除重复 operation，并把仍有效的 SLA 绑定恢复为单一职责。
```

---

## Task 12：文档、接口盘点、全量质量门与浏览器验收

**Files**

- Modify: `docs/plan/2026-05-31-feature-interface-inventory.md`
- Modify: `apps/web/src/features/docs/system-docs.tsx`
- Create: `docs/model-marketplace-operations.md`
- Modify: `.env.example`
- Modify: `docs/MEMORY.md` 与相关 `docs/memory/*`（仅记录长期有效事实）

**文档**

- 登记三个 UOL operation 的名称、权限、幂等、破坏性和传输方式；
- 记录 `MODEL_MARKETPLACE_CONFIG`、资产 bucket、Local/S3 行为、5 MB、像素限制、3:2 WebP、
  缓存和故障回退；
- 管理员文档把“模型计费”改为“模型配置”；
- `.env.example` 增加准确的
  `MODEL_MARKETPLACE_ASSETS_BUCKET_NAME=model-marketplace` 初始化示例；它与同名 system
  setting 是同一配置的部署种子，不再引入第二个 bucket 变量，运行时以数据库设置为真相；
- 文档明确展示开关不影响 `/v1/models`、调度、创作目录和计费。

**聚焦安全回归**

```bash
pnpm --filter @repo/shared exec vitest run \
  src/uol/operations/model-marketplace.test.ts \
  src/system-settings/defaults.test.ts
pnpm --filter @repo/web exec vitest run \
  src/features/model-configuration \
  src/features/model-marketplace \
  'src/app/api/storage/[bucket]/[...key]/route.test.ts'
pnpm --filter @repo/web exec vitest run \
  src/features/external-api/handlers/models.test.ts \
  src/features/external-api/platform-model-catalog.test.ts
```

**全量质量门**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

任何失败都必须修复根因，不使用 skip、弱化断言或 `--no-verify`。

**浏览器验收**

模型广场、详情、导航、Footer 和首页在中文与英文各验证一次；管理后台沿用项目当前中文
界面，只需验证一次。全部流程检查控制台无错误：

1. 管理列表：搜索、图像/视频筛选、未配置价格、真实品牌图标、最低价格。
2. 编辑 Dialog：四档/每秒价格、简介 200 字、Switch、封面预览、替换、移除、取消。
3. 并发：两个会话编辑同一模型，后保存者收到冲突且草稿保留。
4. 幂等：模拟保存响应丢失后复用同一 `clientRequestId`，不重复审计或存储副作用。
5. `/models`：1440、1024、768、320 像素；三列、两列、单列与移动筛选。
6. 卡片：图标、长 ID、紧随 ID 的复制图标、最低价格、复制成功/失败反馈。
7. 详情：完整价格、参数、焦点、Esc、关闭回焦和移动端形态。
8. “立即使用”：图像和视频合法预选；无权限/已移除模型安全回退。
9. 首页：关闭模型后同步隐藏；全部关闭是 ready-empty；配置故障是 unavailable。
10. 安全：匿名只能读取模型资产 bucket 的 WebP，不能扩大 generations 私有访问。
11. 回归：同一用户的 `/v1/models` 响应和创作页可选目录不因 visible 改变。

**最终提交**

```text
docs(models): 补充模型广场运维与接口文档

记录展示配置、资产处理和权限隔离边界，确保部署与后续 Agent 接入不绕过 UOL。
```

## 完成定义

- 十二个 Task 全部提交，工作树仅剩用户原有的未跟踪或无关改动；
- 三个新 operation 已登记且真实调用均经过 `invokeOperation`；
- 没有旧的全快照模型价格写入口或重复公共目录 operation；
- 全量质量门与浏览器验收通过；
- `.superpowers/` 未进入任何提交；
- 用户确认后再按项目版本规则打 tag、推送 `main`，不得自行 force-push。
