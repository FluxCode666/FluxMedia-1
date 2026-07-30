---
name: write-api-request-transform
description: 根据用户提供的上游 API 参数语义、请求样例、HAR 或文档，生成并校验 FluxMedia API 账号使用的 JavaScript 请求处理脚本；适用于 Images 生成、Images multipart 编辑和 Videos 生成的字段改名、嵌套重组、枚举转换、默认值、条件参数与输入图适配。遇到模型 ID 差异时同时给出账号级 modelMappings 配置，不把模型映射硬编码进脚本。
---

# 编写上游请求处理脚本

## 目标

把“平台标准请求”转换成“当前 API 账号供应商所需的请求体”，输出可直接填入账号配置的同步 JavaScript 脚本。只处理请求体；不得尝试修改 URL、HTTP 方法、请求头或 API Key。

## 工作流

### 1. 读取现行契约

先完整读取 [references/runtime-contract.md](references/runtime-contract.md)。在
FluxMedia 仓库中再核对：

- `docs/memory/api-account-upstream-adaptation.md`
- `apps/web/src/features/image-backend-pool/request-transform-runtime.ts`
- `apps/web/src/features/image-generation/service.ts`
- `apps/web/src/features/image-generation/api-video.ts`

以源码为准，不凭模型名称猜能力。确认请求属于 `images.generate`、`images.edit` 或 `videos.generate`，以及 `application/json` 或 `multipart/form-data`。

### 2. 收集上游事实

优先从用户提供的 HAR、请求体、响应错误、供应商文档和参数表取证。403 等鉴权结果不影响参数分析。至少整理：

- 平台请求样例和上游期望请求样例；
- 平台字段、上游字段、类型、单位、枚举和必填条件；
- 模型 ID 是否只是名称不同；
- `client_request_id` 对应的上游幂等字段；
- 首帧、尾帧、参考图、声音和负向提示词的字段形状；
- 同一模型不同模式（文生、首尾帧、参考图）的条件差异。

缺少会改变脚本语义的事实时，先逐项向用户确认；不要用猜测补齐供应商约定。

### 3. 分离模型映射与脚本转换

- 平台模型 `seedance2` 对应上游 `seedande-2.0` 时，输出账号配置：

  ```json
  { "modelId": "seedance2", "upstreamModelId": "seedande-2.0" }
  ```

  脚本中的 `request.model` 已经是上游模型 ID，不要再次写死或覆盖为平台 ID。
- 字段改名、移动、嵌套、类型转换、枚举转换、默认值和条件字段才写入脚本。
- 如果用户要求改 URL、Method、Header、Authorization 或 API Key，明确说明当前脚本契约不支持，并把需求留给适配器代码改造。

### 4. 先写映射表，再写脚本

输出一张简短的语义表，至少包含平台字段、上游字段、转换方式和条件/风险。说明哪些字段保持原样、哪些字段删除、哪些字段互斥，以及未知枚举是拒绝还是透传。对数组必须明确是保留数组、取单项还是展开为重复 multipart 字段。

### 5. 生成脚本正文

脚本必须满足以下格式：

```js
request.ratio = request.aspect_ratio;
delete request.aspect_ratio;
return request;
```

遵守：

- 只输出函数体，不写 `function transform`、`async`、模块导入或 Markdown 外的包装；
- 必须同步执行并以 `return request;` 返回普通对象；
- 脚本作用域只使用可修改的 `request` 和只读 `context`，不要访问全局宿主对象；
- 仅在字段存在时移动或转换，避免向供应商发送无意义的 `undefined`；
- 使用 `Object.hasOwn` 或显式 `typeof` 判断可选字段；
- 默认值只在 `request.field === undefined` 时补齐，不覆盖用户显式传入的值；
- 不改变平台语义，不复制媒体令牌，不把同一媒体同时放进两个字段。

对于多操作共用脚本，用 `context.operation` 分支；每个分支都必须最终返回同一个 `request` 对象：

```js
if (context.operation === "videos.generate") {
  if (request.aspect_ratio !== undefined) {
    request.ratio = request.aspect_ratio;
    delete request.aspect_ratio;
  }
}
return request;
```

### 6. 校验与验证

为每个受影响操作提供 before/after JSON 示例，并检查：

1. `model` 是否保持账号模型映射后的上游 ID；
2. `client_request_id` 是否保留或移动到等价的上游幂等字段；
3. 必填字段、类型、单位和枚举是否符合上游语义；
4. 首尾帧与参考图是否仍然互斥；
5. 每个媒体令牌是否恰好保留一次；
6. 脚本失败时请求不会发出；
7. 脚本没有使用 `process`、`require`、`fetch`、定时器、Promise、文件、网络、动态代码、时间或随机数。

在仓库中工作时，优先用 `applyApiRequestTransformScript` 的现有 Vitest 测试扩展真实样例；不要用 Node `eval` 或 `new Function` 代替生产 QuickJS 运行时验证。脚本源码不得超过 32,768 个 UTF-16 代码单元，序列化输入/输出不得超过 2 MiB，执行预算为 50 ms。

`client_request_id` 用于降低超时或重试时的重复提交风险，不得静默删除。上游字段名称不同时移动到等价幂等字段；上游完全不支持幂等键时，先向用户说明重复提交风险并取得明确确认。

## 常用转换模式

### 字段移动

```js
if (request.aspect_ratio !== undefined) {
  request.ratio = request.aspect_ratio;
  delete request.aspect_ratio;
}
```

### 枚举转换

```js
const resolutionMap = { "720p": "hd", "1080p": "fhd" };
if (typeof request.resolution === "string") {
  if (Object.hasOwn(resolutionMap, request.resolution)) {
    request.resolution = resolutionMap[request.resolution];
  } else {
    throw new Error("Unsupported resolution");
  }
}
```

只有在用户给出完整枚举表时才创建映射；上例仅适用于账号能力不包含其他分辨率的情况。若映射表不完整，先确认未知值策略：上游严格枚举时抛错并阻止请求；只有上游确认兼容同名值或用户明确选择时才原值透传。不得自行选择失败开放或失败关闭。

### 条件参数

```js
if (request.generate_audio === true) {
  request.audio = { enabled: true };
} else if (request.generate_audio === false) {
  request.audio = { enabled: false };
}
delete request.generate_audio;
```

### 数值或单位转换

```js
if (typeof request.duration === "number") {
  request.duration_ms = Math.round(request.duration * 1000);
  delete request.duration;
}
```

只有在上游单位已确认时才转换；禁止根据字段名推测秒、毫秒、像素或积分。

## 媒体输入规则

- Images multipart 单图字段是 `image`，多图字段是 `image[]`；脚本必须覆盖实际输入模式，不能只适配单图。重复字段在脚本中表现为数组，输出顶层数组会重新展开为同名 multipart 字段。
- Images multipart 的文件和 mask 只能移动到顶层字段或顶层数组元素；Videos JSON 媒体可以移动到嵌套字段。两类请求的每个宿主令牌都必须恰好保留一次。
- 移动媒体前检查源字段互斥且目标字段为空；冲突时抛错，不能覆盖、合并或静默丢弃已有媒体。
- 平台已保证首尾帧与参考图互斥；脚本不得把两种输入合并或复制成同时存在。
- 参考图数量由模型能力配置约束；脚本不得截断或静默丢弃 `reference_images`。供应商数量限制不一致时，报告并修改模型能力配置。
- 不要解码、拼接、裁剪或生成 data URL；真实媒体值由宿主在脚本后恢复。

## 交付格式

每次生成脚本时按以下顺序返回：

1. “账号模型映射”列表（没有差异则写“无需映射”）；
2. “字段映射表”；
3. 可直接粘贴的 JavaScript 脚本正文；
4. 每个操作的 before/after 示例；
5. 已验证项、未确认项和明确风险；
6. 若无法仅靠脚本实现，列出需要适配器或供应商确认的事项。

不要静默吞掉冲突。若上游要求的能力超出当前运行时契约，先报告阻塞点，再给出最小安全替代方案。

## 参考资料

[references/runtime-contract.md](references/runtime-contract.md) 记录当前 FluxMedia 请求字段、沙箱限制和媒体令牌边界。若源码和参考资料不一致，以源码为准并报告差异。
