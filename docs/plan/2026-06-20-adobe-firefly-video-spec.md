# Adobe Firefly 视频接口规格（移植自 adobe2api，用于 firefly-direct 视频实现）

> 来源：调研 adobe2api（Python）的视频路径，并使用 2026-07-27 的 Adobe Express
> Seedance 2.0 脱敏 HAR，以及 2026-07-28 的 Adobe Firefly Kling 3.0 Omni、
> Runway Gen-4.5、Ray 3.14 与 Ray 3.14 HDR 脱敏请求校正网页真实协议。仅记录
> 接口契约
> （端点/字段/枚举），不保存
> Cookie、Token、账号/任务/素材 ID、提示词或预签名 URL。初始日期：2026-06-20。
> 参考文件（adobe2api）：`core/adobe_client.py`、`core/models/catalog.py`、
> `core/models/resolver.py`、`api/routes/generation.py`。

## 1. 视频模型目录

model-id 格式：`firefly-{family}-{dur}s-{ratio}[-{res}]`；ratio 后缀
`1:1→1x1, 4:3→4x3, 3:4→3x4, 16:9→16x9, 9:16→9x16, 21:9→21x9`。

| family | model-id 格式 | 时长(s) | 比例 | 分辨率 | upstream `model` | `modelId` | `modelVersion` | engine/flags |
|---|---|---|---|---|---|---|---|---|
| sora2 | `firefly-sora2-{d}s-{ratio}` | 4,8,12 | 9:16,16:9 | 720p 固定 | `openai:firefly:colligo:sora2`（待核 base vs pro） | `sora` | `sora-2` | sora2 |
| sora2-pro | `firefly-sora2-pro-{d}s-{ratio}` | 4,8,12 | 9:16,16:9 | 720p | `openai:firefly:colligo:sora2-pro` | `sora` | `sora-2` | sora2 |
| veo31 | `firefly-veo31-{d}s-{ratio}-{res}` | 4,6,8 | 16:9,9:16 | 1080p,720p | `google:firefly:colligo:veo31` | `veo` | `3.1-generate` | `veo31-standard` |
| veo31-ref | `firefly-veo31-ref-{d}s-{ratio}-{res}` | 4,6,8 | 16:9,9:16 | 1080p,720p | `google:firefly:colligo:veo31` | `veo` | `3.1-generate` | `veo31-standard` + `reference_mode:"image"` |
| veo31-fast | `firefly-veo31-fast-{d}s-{ratio}-{res}` | 4,6,8 | 16:9,9:16 | 1080p,720p | `google:firefly:colligo:veo31-fast` | `veo` | `3.1-fast-generate` | `veo31-fast` |
| kling-o3 | `firefly-kling-o3-{d}s-{ratio}` | 5,15 | 16:9,9:16 | 1080p 固定 | `kling:firefly:colligo:o3` | `kling` | `kling_o3_pro_reference_to_video` | `kling-o3` |
| kling3 | `firefly-kling3-{d}s-{ratio}` | 5,10,15 | 16:9,9:16 | 720p 固定 | `kling:firefly:colligo:3.0` | `kling` | `kling_v3_standard_i2v` | `kling3` + 默认有声 |
| kling3-omni | `firefly-kling3-omni-{d}s-{ratio}-{res}` | 3–15（逐秒） | 16:9,9:16 | 720p,1080p | 不发送 | `kling` | `kling_o3_standard_t2v` | `kling3-omni` + 默认无声 + 单图 style |
| runway-gen45 | `firefly-runway-gen45-{d}s-16x9` | 5,8,10 | 16:9 | 720p 固定 | 不发送 | `runway` | `gen4.5` | `runway-gen45` + 无声 + 仅文本 |
| ray314 | `firefly-ray314-{d}s-{ratio}-{res}` | 5,10 | 1:1,4:3,3:4,16:9,9:16,21:9 | 720p,1080p,4k | 不发送 | `luma` | `3.14-ray` | `ray314` + `mode:flex_2` + 无声 + 仅文本 |
| ray314-hdr | `firefly-ray314-hdr-{d}s-{ratio}-{res}` | 5 | 1:1,4:3,3:4,16:9,9:16,21:9 | 720p,1080p,4k | 不发送 | `luma` | `3.14-ray-hdr` | `ray314-hdr` + 无声 + 仅文本 |
| seedance2 | `firefly-seedance2-{d}s-{ratio}-{res}` | 4–15（逐秒） | 1:1,4:3,3:4,16:9,9:16,21:9 | 480p,720p,1080p | 不发送 | `seedance` | `seedance_2.0` | `seedance2` + 默认无声 + 单图 style |
| seedance2-fast | `firefly-seedance2-fast-{d}s-{ratio}-{res}` | 4–15（逐秒） | 1:1,4:3,3:4,16:9,9:16,21:9 | 480p,720p | 不发送 | `seedance` | `seedance_2.0_fast` | `seedance2` + 默认无声 + 单图 style |

表中的 `firefly-*` 是规范模型 ID；入口同时兼容不带前缀的 `veo31*`、`veo31-ref*`、
`veo31-fast*`、`kling-o3*`、`kling3*`、`kling3-omni*`、`runway-gen45*`、
`ray314*`、`ray314-hdr*`、`seedance2*`、`seedance2-fast*` 裸模型，内部统一
归一化后按同一目录派发。

## 2. Adobe Firefly 上游视频 API（host `https://firefly-3p.ff.adobe.io`）

- **提交（异步）**：`POST /v2/3p-videos/generate-async` → 返回 job；**轮询地址取响应头 `x-override-status-link`**，回退 JSON `links.result`。
- **轮询**：`GET {poll_url}`，Seedance 网页样本约每 2s，客户端默认可为 3s；状态读 JSON
  `status`（或头 `x-task-status`）。
  - 进行中：`IN_PROGRESS/RUNNING/PROCESSING/PENDING/QUEUED/STARTED`
  - 失败终态：`FAILED/CANCELLED/ERROR`
  - 成功：必须等待 `x-task-status: COMPLETED` 或等价成功状态。Seedance 在
    `IN_PROGRESS/progress=80` 时已经返回 `outputs[0].video.presignedUrl`，不能只凭 URL
    提前完成。
- **结果**：视频 URL = `outputs[0].video.presignedUrl`；`GET {presignedUrl}`（`accept: */*`）取字节。
- **图片上传（i2v 首帧/尾帧/参考）**：`POST /v2/storage/image`（原始字节 + mime）→ id 取 `data.images[0].id`。

### 鉴权头（提交）
```
Authorization: Bearer {ims_token}
x-api-key: {api_key}            # 生成用的 api_key（与 credits 调用的 SunbreakWebUI1 是否同值待核）
content-type: application/json
accept: */*
x-arp-session-id: {generated}
x-nonce: sha256(`${user_id}-${prompt[:256]}`)
```
+ 浏览器伪装头（user-agent、sec-ch-ua、origin/referer）。Adobe Express 模型使用
`https://new.express.adobe.com/` 与公开网页 API Key `projectx_webapp`；Kling 3.0 Omni、
Runway Gen-4.5、Ray 3.14、Ray 3.14 HDR、Seedance 2.0 与 Seedance 2.0 Fast 使用
`https://firefly.adobe.com/` 与公开网页 API Key `clio-playground-web`。Seedance
提交明确携带 `x-arp-session-id` 和
`x-nonce`。Chrome sanitized HAR 会移除敏感鉴权头，因此不能根据 HAR 中未显示
`Authorization` 推断真实请求不需要 Bearer Token。
IMS Token 必须与网页 Profile 绑定：Express 使用 `client_id=projectx_webapp`，Firefly
使用 `client_id=clio-playground-web`。同一 Cookie 分别持久化两套短期 Token；上传、
提交和轮询使用任务保存的同一请求/鉴权 Profile。明确 401/403 时只刷新该 Profile 并
安全重试一次，网络异常、5xx 或提交结果不确定时不得自动重投。

### 提交体（关键字段）
`n`、`seeds:[seed]`、`seed:str`、`modelId`、`model`(upstream)、`modelVersion`、`size:{width,height}`、
`duration`、`fps:24`、`prompt`、`negativePrompt`、`generateAudio:bool`、`generateLoop`、
`transparentBackground`、`locale`、`camera`、`jobMode:"standard"`、
`generationMetadata:{module:"text2video"|"image2video"}`、`referenceBlobs`、`referenceFrames`、`output`。

`generateAudio` 是请求级开关。Seedance 2.0（含 Fast）与 Kling 3.0 Omni 默认
`false`，Kling 3.0 默认 `true`；调用方可以逐次覆盖。Runway Gen-4.5 与 Ray 3.14
（含 HDR）不支持声音，其提交体不发送 `generateAudio`。其他目录模型当前不声明
音频能力，传 `true` 会在统一接口层拒绝，传 `false` 可兼容统一客户端。

### size 映射

Adobe 的分辨率标签以画幅短边为基准。4:3 基准尺寸由网页选项确认，其余比例按同一
短边规则推导；16:9 的 480p 长边取相邻偶数 854。

| 分辨率 | 1:1 | 4:3 | 3:4 | 16:9 | 9:16 | 21:9 |
|---|---|---|---|---|---|---|
| 480p | 480×480 | 640×480 | 480×640 | 854×480 | 480×854 | 1120×480 |
| 720p | 720×720 | 960×720 | 720×960 | 1280×720 | 720×1280 | 1680×720 |
| 1080p | 1080×1080 | 1440×1080 | 1080×1440 | 1920×1080 | 1080×1920 | 2520×1080 |
| 4k | 2160×2160 | 2880×2160 | 2160×2880 | 3840×2160 | 2160×3840 | 5040×2160 |

本次 Seedance 2.0 HAR 的真实选项是 `480p / 9:16 / 15s`，提交尺寸为
`size:{width:480,height:854}`；最终媒体元数据为 496×864、24 FPS、361 帧。

### Seedance 2.0 已验证提交体

单张图片、关闭音频的脱敏字段如下；未出现 `n`、`fps`、`model`、`engine`、
`referenceFrames`：

```json
{
  "modelId": "seedance",
  "modelVersion": "seedance_2.0",
  "size": { "width": 480, "height": 854 },
  "seeds": [123456],
  "referenceBlobs": [{ "id": "<已脱敏>", "usage": "style" }],
  "prompt": "<已脱敏>",
  "negativePrompt": "<已脱敏>",
  "duration": 15,
  "generateAudio": false,
  "generationMetadata": {
    "module": "text2video",
    "submodule": "ff-video-generate"
  },
  "generationSettings": { "aspectRatio": "9:16" },
  "output": { "storeInputs": true }
}
```

### Kling 3.0 Omni 已验证提交体

已验证文本样本为 10 秒、16:9、720p、关闭声音；所有账号、任务、会话、素材和提示词
内容均未保留：

```json
{
  "n": 1,
  "seeds": [123456],
  "modelId": "kling",
  "modelVersion": "kling_o3_standard_t2v",
  "output": { "storeInputs": true },
  "duration": 10,
  "prompt": "<已脱敏>",
  "size": { "height": 720, "width": 1280 },
  "generateAudio": false,
  "generationMetadata": { "module": "text2video" },
  "generationSettings": { "aspectRatio": "16:9" },
  "referenceBlobs": []
}
```

图片输入由用户补充确认与 Seedance 2.0 相近，当前实现限制单图并映射为
`referenceBlobs:[{id,usage:"style"}]`；上述文本样本本身只验证了空数组形态。

### Runway Gen-4.5 已验证提交体

已验证文本样本为 5 秒、16:9、720p。该请求不包含 `generateAudio`、`n`、
`referenceBlobs` 或 `generationSettings`，所有账号、任务、会话和提示词内容均未保留：

```json
{
  "modelId": "runway",
  "modelVersion": "gen4.5",
  "size": { "height": 720, "width": 1280 },
  "seeds": [123456],
  "prompt": "<已脱敏>",
  "negativePrompt": "<已脱敏>",
  "duration": 5,
  "generationMetadata": {
    "module": "text2video",
    "submodule": "ff-video-generate"
  },
  "output": { "storeInputs": true }
}
```

当前文本样本未出现图片字段，因此暂不开放图片输入；获得带图样本后再扩展。

### Ray 3.14 已验证提交体

已验证文本样本为 5 秒、16:9、4k，提交尺寸为 3840×2160。该请求不包含
`generateAudio`、`n`、`seeds`、`referenceBlobs` 或 `generationSettings`，所有账号、
任务、会话和提示词内容均未保留：

```json
{
  "modelId": "luma",
  "modelVersion": "3.14-ray",
  "size": { "width": 3840, "height": 2160 },
  "mode": "flex_2",
  "prompt": "<已脱敏>",
  "negativePrompt": "<已脱敏>",
  "duration": 5,
  "generationMetadata": {
    "module": "text2video",
    "submodule": "ff-video-generate"
  },
  "modelSpecificPayload": {
    "resolution": "4k",
    "aspect_ratio": "16:9"
  },
  "output": { "storeInputs": true }
}
```

720p 与 1080p 复用现有短边映射；4k 的 16:9 尺寸由抓包确认，其余画幅按同一短边
2160 像素规则派生。当前样本未出现图片字段，因此目录输入图上限为 0。

### Ray 3.14 HDR 已验证提交体

已验证文本样本为 5 秒、16:9、4k，提交尺寸为 3840×2160。该请求不包含普通
Ray 3.14 的 `mode:"flex_2"`，也不包含 `generateAudio`、`n`、`seeds`、
`referenceBlobs`、`referenceFrames`、`generationSettings`、`model` 或 `engine`。
所有账号、任务、会话和提示词内容均未保留：

```json
{
  "modelId": "luma",
  "modelVersion": "3.14-ray-hdr",
  "size": { "width": 3840, "height": 2160 },
  "prompt": "<已脱敏>",
  "negativePrompt": "<已脱敏>",
  "duration": 5,
  "generationMetadata": {
    "module": "text2video",
    "submodule": "ff-video-generate"
  },
  "modelSpecificPayload": {
    "resolution": "4k",
    "aspect_ratio": "16:9"
  },
  "output": { "storeInputs": true }
}
```

HDR 目录仅开放 5 秒；分辨率、比例和尺寸映射与普通 Ray 3.14 相同。4k 仅 16:9
尺寸由样本直接确认，其他比例复用短边 2160 像素规则推导。当前样本明确不支持图片
输入，因此目录输入图上限为 0。

## 3. 与图像路径的差异
图像 `POST /v2/3p-images/generate-async`，视频 `POST /v2/3p-videos/generate-async`——**同构**（submit→poll→download、`x-override-status-link` 轮询、`/v2/storage/image` 上传、referenceBlobs）。视频增加 `duration/fps/generateAudio/referenceFrames` 与视频专属 `modelId/modelVersion/engine`，结果读 `outputs[0].video.presignedUrl`。

## 4. 图生视频输入挂载（先上传 /v2/storage/image 拿 id）
- **Sora2**：`referenceBlobs:[{id, usage:"general", promptReference:1}]`；`referenceFrames:[{localBlobRef:first}, null]`，首+尾帧时第二槽 `{localBlobRef:last}`。
- **Veo31/veo31-ref**：同 referenceBlobs/frames；veo31-ref 加 `reference_mode:"image"`。
- **Kling(o3/3.0)**：帧 `referenceBlobs:[{id, usage:"frame", order:idx}]`；kling-o3 实体引用 `{usage:"element", creativeCloudFileId:urn, mention:{id}}`。
- **Kling 3.0 Omni**：用户补充其图片参数与 Seedance 2.0 相近，当前按单张
  `referenceBlobs:[{id,usage:"style"}]` 接入；仍需带图请求样本复核。
- **Runway Gen-4.5**：当前文本样本未出现图片字段，目录输入图上限为 0，不上传或
  转发参考图。
- **Ray 3.14**：当前文本样本未出现图片字段，目录输入图上限为 0，不上传或转发
  参考图。
- **Ray 3.14 HDR**：已确认不支持参考图，目录输入图上限为 0，不上传或转发参考图。
- **Seedance 2.0 已验证样本**：网页按原始 PNG 字节上传，`Content-Length` 与用户提供
  的 1254×1254 PNG 文件大小完全一致，不先裁剪到 480×854。
- 其他模型继续沿用既有目标尺寸预处理，待各自 HAR 复核。

## 5. 待核校点（移植时验证）
- base-sora2 vs sora2-pro 的 upstream `model` 串；
- 生成用 `x-api-key` 具体值（config 驱动）；
- `generationMetadata.module` 在非 Kling 引擎、有输入帧时是否翻成 `image2video`（Kling 已确认，其余条件性）。
- Seedance 2.0 纯文生视频和首尾帧模式。

## 6. 本仓库落地计划（firefly-direct 视频）
1. `firefly-direct/video-catalog.ts`：上表的纯数据 catalog + `resolveFireflyVideoModel(id)`。
2. `firefly-direct/client.ts`：`generateVideo()`（submit→poll→download，复用 transport/IMS）。
3. `video_generation` 表 + 迁移（status/model/duration/ratio/resolution/输入图引用/storageKey/credits）。
4. `adobe-direct.ts`：视频派发（i2v 先 upload 再 referenceBlobs/frames）。
5. 计费：**30 积分/秒**统一基价 + **按模型倍率**（config）；接 credits（预扣/结算/退款，幂等 sourceRef）。
6. 创作页视频 tab（选模型+时长+比例[+分辨率]；图生视频 @ 历史图）。
7. v1 视频 API 端点。
