# FluxMedia 请求处理运行时契约

## 账号模型配置

`supportedModelIds` 只保存平台真实模型 ID。`config.modelMappings` 保存稀疏的
`modelId -> upstreamModelId` 映射；来源必须属于该账号支持模型，且大小写不敏感唯一。
未配置映射的模型同名透传，脚本不得再次覆盖映射后的 `request.model`。

## 脚本可见上下文

```ts
type Context = {
  operation: "images.generate" | "images.edit" | "videos.generate";
  contentType: "application/json" | "multipart/form-data";
  platformModelId: string;
  upstreamModelId: string;
};
```

`request.model` 在脚本运行前已经是 `upstreamModelId`。`platformModelId` 只用于按操作或平台模型做条件分支，不要把它写回请求体。

## 平台标准请求字段

### `images.generate`，JSON

常见字段：`model`、`prompt`、`n`、`size`、`width`、`height`、`quality`、`moderation`、`output_format`、`output_compression`、`background`、`stream`、`partial_images`、`response_format`。

字段是否出现取决于用户请求和账号配置；脚本不得假设所有可选字段都存在。
`prompt` 在脚本执行前已追加平台缓存 nonce，应把它视为不透明文本并完整保留。

### `images.edit`，multipart

文本字段与生成接口大体相同；标准字段包括 `model`、`prompt`、`n`、`response_format`，以及可选 `size`、`width`、`height`、`quality`、`moderation`、`output_format`、`output_compression`、`background`、`stream`、`partial_images`。单张输入图使用 `image`；多张输入图使用重复的 `image[]`；蒙版使用 `mask`。

所有 multipart 文本字段进入脚本时都是字符串，包括 `n`、`width`、`height`、
`output_compression`、`stream` 和 `partial_images`。`prompt` 已追加缓存 nonce，并可能把
`@图N` 展开为输入图引用标签；移动字段时完整保留，不要修剪或重建文本。

multipart 的重复键在脚本对象中表现为数组。重命名时保留数组顺序；源字段或目标字段冲突时应失败关闭，例如：

```js
const hasSingleImage = Object.hasOwn(request, "image");
const hasMultipleImages = Object.hasOwn(request, "image[]");
if (hasSingleImage && hasMultipleImages) {
  throw new Error("conflicting image fields");
}
if (
  (hasSingleImage || hasMultipleImages) &&
  Object.hasOwn(request, "source")
) {
  throw new Error("conflicting source field");
}
if (hasSingleImage) {
  request.source = request.image;
  delete request.image;
} else if (hasMultipleImages) {
  request.source = request["image[]"];
  delete request["image[]"];
}
return request;
```

平台不会在同一请求中同时生成 `image` 和 `image[]`。输出数组会重建为同名的重复 multipart 字段；不要把媒体数组嵌套进对象。
输出数字和布尔值会编码为 multipart 文本；普通对象会编码为 JSON 文本；`null` 和
`undefined` 字段会被省略。含媒体的对象或嵌套数组会失败关闭。

### `videos.generate`，JSON

标准字段包括 `client_request_id`、`prompt`、`model`、`duration`、`aspect_ratio`、`resolution`、`generate_audio` 和可选 `negative_prompt`、`first_frame`、`last_frame`、`reference_images`。`client_request_id` 是提交幂等标识；可移动到供应商的等价字段，但不能静默删除。

首尾帧和参考图由平台能力校验保证互斥；脚本只能适配上游字段名称或结构，不能绕过互斥约束。
全部视频输入图的 data URL 编码后总长度不得超过 64 MiB；该校验发生在脚本执行前，
不构成参考图数量硬上限。

请求脚本不能转换上游响应。提交响应须提供 `task_id`、`id` 或 `generation_id`；轮询响应
须使用平台已支持的状态和 `video_url`、`url` 或 `output_url`。不兼容时需要修改适配器。

## QuickJS 安全限制

- 源码最多 32,768 个 UTF-16 代码单元；同步执行最多 50 ms；VM 内存最多 32 MiB；栈最多 512 KiB；输入和输出序列化最多 2 MiB。
- 不可使用 `process`、`require`、`fetch`、XHR、WebSocket、文件、网络、定时器、Promise、动态代码执行、`Date` 或 `Math.random`。
- 脚本不能读取凭据、URL、Method、Header、用户 ID、账号 ID 或分组信息。
- 输出必须是普通 JSON 对象，不得返回 `null`、数组、Promise、函数、Blob 或非 JSON 值。
- `__proto__`、`constructor`、`prototype` 等危险键会被拒绝。

## 媒体令牌

宿主把真实 Blob 或 data URL 放在 VM 外，并用随机令牌代替。脚本可以移动令牌，但不能：

1. 删除令牌；
2. 将令牌复制到两个位置；
3. 拼接、截断或伪造令牌；
4. 在 Images multipart 中把令牌放入嵌套对象或嵌套数组。

宿主在输出后恢复真实媒体；视频 JSON 的令牌可被移动到上游要求的嵌套字段。所有令牌必须恰好保留一次。

## 运行时失败语义

脚本语法错误、超时、异常、非法输出或媒体令牌不变量破坏都会在网络请求前失败。图片请求返回脚本错误；视频提交将该账号标记为尚未被上游接受的可切换故障。不要通过脚本捕获并隐藏这些失败。
