---
name: write-api-upstream-adapter
description: 根据供应商 API 文档、参数说明、HAR、请求响应样例或错误信息，为 FluxMedia API 类型账号生成并校验六操作上游适配配置，包括相对路径、四种认证、真实模型 ID 映射、请求 JavaScript、响应 JavaScript 和无网络测试夹具。适用于文生图、图生图和生视频的同步或异步上游协议，以及 Query、Header、Body、任务状态、URL、Base64、首尾帧和多参考图适配。
---

<!--
本 Skill 指导 Codex 在不访问真实供应商的前提下，为 FluxMedia API 账号生成完整、
可审查并可用生产 QuickJS 契约验证的六操作适配配置。
-->

# 编写 API 上游适配器

## 核心目标

把供应商事实转换为账号级完整适配配置。生成路径、认证、模型映射、请求脚本、响应
脚本和测试夹具，不只生成请求 Body 转换代码。

坚持以下不变量：

- 平台只保存和选择真实模型 ID，不把时长、比例或分辨率编码进模型 ID；
- 模型名称差异写入账号模型映射，不硬编码进脚本；
- 路径、Method 和认证由宿主控制，脚本只转换有界数据；
- 首尾帧和参考图始终互斥，媒体令牌必须恰好保留一次；
- 生成请求一旦发出或取得任务 ID，不设计换号重投流程；
- 不访问真实上游，不读取真实密钥，不产生生成费用。

## 工作流

### 1. 读取共享契约和媒体参考

先完整读取 [references/runtime-contract.md](references/runtime-contract.md)，再按任务读取：

- 文生图：
  [references/text-to-image.md](references/text-to-image.md)
- 图生图、蒙版或多图编辑：
  [references/image-to-image.md](references/image-to-image.md)
- 文生视频、首尾帧或参考图视频：
  [references/video.md](references/video.md)

请求同时覆盖多类媒体时，分别读取对应参考文件，但保持一套共享分析和交付流程。

在 FluxMedia 仓库中工作时，再核对当前源码：

- `packages/shared/src/image-backend/api-upstream-adaptation.ts`
- `packages/shared/src/image-backend/api-upstream-script-contract.ts`
- `apps/web/src/features/image-backend-pool/api-upstream-executor.ts`
- `apps/web/src/features/image-backend-pool/api-upstream-request-envelope.ts`
- `apps/web/src/features/image-backend-pool/api-upstream-response.ts`
- `apps/web/src/features/image-generation/service.ts`
- `apps/web/src/features/image-generation/api-video.ts`

源码与参考文件冲突时以源码为准，并在交付中明确报告差异，不静默沿用旧契约。

### 2. 从用户资料建立事实表

优先使用供应商文档、HAR、请求响应样例、字段说明和错误响应取证。HAR 中的 403 只表示
鉴权结果，不妨碍分析请求参数。不得根据供应商名称或模型名称猜字段。

逐操作整理：

- `baseUrl`、相对路径、固定 Method 和内容类型；
- 认证值应该以 Bearer、Raw Authorization、自定义 Header 还是无认证发送；
- 平台模型 ID 与供应商模型 ID；
- 请求字段名称、类型、单位、枚举、默认值和互斥条件；
- 幂等字段及 `client_request_id` 的等价位置；
- 图片 URL、Base64、multipart 单图、多图和 mask 形状；
- 视频首帧、尾帧、参考图、声音和负向提示词形状；
- 同步结果、异步 task ID、任务状态、进度、错误和结果字段；
- `Retry-After` 或供应商建议轮询间隔；
- 供应商是否明确不支持平台需要的能力。

缺失事实会改变语义时，列为“待确认”，不要补猜测。尤其不要猜秒与毫秒、像素、
枚举、Base64 media type、任务成功状态或幂等保证。

### 3. 设计账号级配置

固定六个操作：

```text
images.generate
images.generate.query
images.edit
images.edit.query
videos.generate
videos.query
```

按以下顺序决定配置：

1. 只把平台真实模型 ID 放入 `supportedModelIds`。
2. 为名称不同的模型生成稀疏 `modelMappings`。
3. 选择共享认证模式；永不把密钥写进脚本、Query、文档或夹具。
4. 为每个操作选择安全相对路径；查询路径必须含一个 `{task_id}`。
5. 供应商兼容内置协议时将对应脚本留空。
6. 只为已确认的差异编写请求或响应脚本。
7. 异步图片必须配置对应查询路径和查询响应适配。

上游返回的 `poll_url` 或 `status_url` 不能作为查询配置。查询必须继续使用管理员路径和
宿主 `context.taskId`。

### 4. 先写字段与状态映射，再写代码

为每个非空脚本先写映射表，至少包含：

- 平台来源；
- 供应商目标；
- 类型或单位转换；
- 必填条件；
- 未知枚举策略；
- 是否涉及幂等或媒体令牌；
- 冲突时失败还是透传。

对数组明确保留数组、取单项还是展开为重复 multipart 字段。供应商上限低于平台能力
时，报告配置差异，不能用脚本静默截断。

### 5. 编写同步 JavaScript 函数体

只输出函数体，不写外层 `function transform`。允许在函数体内声明普通函数或箭头函数。
禁止 `import`、第三方库、Promise、网络、文件、计时器和动态代码。

请求脚本读取 `request.query` 和可选 `request.body`，返回部分请求信封：

```js
const body = { ...request.body };
body.ratio = body.aspect_ratio;
delete body.aspect_ratio;
return { body };
```

如果不修改 Headers，省略 `headers` 即可，不需要原样返回。非空脚本仍必须返回对象；
`return {};` 表示不修改，编辑器留空才表示完全使用内置行为。

响应脚本读取 `response.statusCode`、安全 `response.headers` 和 `response.body`，返回标准
状态：

```js
const body = response.body;
return {
  status: "processing",
  taskId: String(body.job_id),
};
```

`pollAfterSeconds` 可选。省略时图片和视频默认均为 5 秒；只有供应商明确要求更长或更短
提示时才返回 `1-300` 的整数。

### 6. 构造无网络测试夹具

为每个非空脚本提供至少一个真实任务形状的合成输入和预期输出：

- 请求夹具使用 `{ query, body? }`；
- 响应夹具使用 `{ statusCode, headers, body }`；
- 媒体使用 `mock://media/<name>`，不得使用真实文件或 data URL；
- 异步生成同时测试任务接受形状；
- 异步查询至少测试一个非终态和一个终态；
- 失败映射测试一个安全错误分类；
- 不调用供应商 URL。

在仓库中优先用管理页的无网络测试 operation 或生产 QuickJS 运行时测试，不用 Node
`eval`、`new Function` 或 `vm` 冒充生产验证。保存校验、测试器和运行时必须接受同一
契约。

### 7. 做失败关闭审查

逐项检查：

1. `request.body.model` 是否保持映射后的供应商 ID；
2. `client_request_id` 是否保留或移动到等价幂等字段；
3. 路径是否同源，查询路径是否只有一个 `{task_id}`；
4. GET 查询是否没有 Body；
5. 认证 Header 是否完全由宿主注入；
6. 未修改的请求部分是否正确省略；
7. 每个媒体令牌是否恰好保留一次；
8. 首尾帧和参考图是否继续互斥；
9. 生成非终态是否返回 task ID；
10. 查询是否拒绝换任务 ID和重新提交；
11. 图片输出是否 URL/Base64 二选一，视频是否只返回 URL；
12. 脚本是否不使用禁用能力且满足所有资源边界；
13. 用户错误、日志和夹具是否不含凭据、Prompt、媒体或上游正文。

## 交付格式

按以下顺序交付：

1. 已确认事实、待确认项和阻塞点；
2. `supportedModelIds` 与账号模型映射；
3. 认证模式和六操作路径表；
4. 每个非空请求脚本的字段映射、源码和 before/after；
5. 每个非空响应脚本的状态映射、源码和 before/after；
6. 同步、异步和失败的无网络测试夹具；
7. 已验证项、未验证项和上线风险；
8. 明确列出保持为空、使用内置行为的脚本。

若供应商要求绝对动态查询 URL、在脚本中签名、读取密钥、异步 I/O、嵌套 multipart
媒体、视频 Base64 输出或其他超出运行时契约的能力，停止生成不可用脚本，报告阻塞点
并给出最小安全的宿主代码改造建议。
