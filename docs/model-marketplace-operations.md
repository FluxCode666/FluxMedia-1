# 模型配置与模型广场运行手册

本文记录模型配置和公开模型广场的现行 UOL、部署、存储与故障边界。代码中的 operation
注册表和 Zod schema 是最终权威。

## UOL operation

| Operation | 权限与 Agent 暴露 | 幂等与破坏性 | 传输方式 |
| --- | --- | --- | --- |
| `settings.getModelConfiguration` | 管理员用户可读；`human-only` | 只读、自然幂等、无副作用 | 管理端 Server Action 构造真实用户 Principal 后调用 `invokeOperation` |
| `settings.updateModelConfigurationEntry` | 仅真实 `super_admin` 用户；`human-only` | `clientRequestId` 按用户必填幂等；破坏性；`storage`、`cache`、`audit` 副作用 | `POST /api/admin/model-configuration` 完成 Origin、会话、正文上限与 multipart 解析后调用 `invokeOperation` |
| `modelMarketplace.listPublicModels` | 仅站内 `system` Principal；`human-only` | 只读、自然幂等、无副作用 | `/models` 与首页 Server Component 进程内调用 `invokeOperation`；无匿名 API 或 MCP 工具 |

管理读取中的 `canEdit` 由真实 Principal 计算，不能从 operation 的管理员读取权限推断。
单模型保存使用 `expectedRevision` 防止并发覆盖，网络重试必须复用同一
`clientRequestId`。图像模型保存必须一次提交完整四档显式价格；底层服务自行开启
数据库事务，传输层和 binding 不再嵌套事务。

## 配置事实与展示边界

- `IMAGE_MODEL_CREDIT_PRICES` 保存图像四档价格；
- `VIDEO_MODEL_CREDITS_PER_SECOND` 保存视频模型族每秒价格；
- `MODEL_MARKETPLACE_CONFIG` 是版本 2 的专用 JSON 真相，独立保存展示开关、简介、
  封面引用、revision 和幂等回执；
- `MODEL_MARKETPLACE_ASSETS_BUCKET_NAME` 保存自定义封面的公开资产 bucket 名称，默认
  `model-marketplace`；它可以与网站品牌和头像资产共用一个私有系统 bucket。

设置初始化会识别历史 `IMAGE_MODEL_CREDIT_PRICES.byModel.default`：先用旧四档价格补齐
已经存在的稀疏真实模型价格，再删除该键；运行时不会继续使用它。合法的模型广场 v1
JSON 会在读取时转换为 v2，并在下一次单模型保存时写回当前结构，无需数据库表迁移。
`.env.example` 中的同名 bucket 变量是首次部署种子，运行时以数据库系统设置为真相。
通用系统设置写入口不能修改
`MODEL_MARKETPLACE_CONFIG`，必须经过单条目 Operation 的并发、幂等与审计边界。
幂等回执随成功保存原子落库，最长保留 24 小时且最多保留 256 条；回执过期后的旧请求
仍会被 revision 拒绝，不会重复执行存储或审计副作用。

公开目录只包含“运行时可达、已显式定价且 `visible` 为 `true`”的图像模型，以及运行时
可达且开启展示的视频模型族。新发现但未定价的图像模型会在管理端显示“未配置价格”，
保存完整四档价格前不能调用计费，也不会公开。展示开关只控制 `/models` 与首页公开
模型区，不影响 `/v1/models`、创作目录、套餐能力、调度或权限。

## 封面处理与存储

上传输入按不可信数据处理：

- multipart 总正文最多 6 MiB，其中封面原文件最多 5 MB；声明长度和流式读取的真实
  字节数都会受限；
- 只接受实际解码为静态 JPEG、PNG 或 WebP 的内容；
- 解码像素上限为 40,000,000，拒绝多页和动画图片；
- 服务端自动旋转、中心裁切为 3:2，输出不超过 1200×800 且不放大小图；
- 移除输入元数据，统一编码为 quality 82 的 WebP；
- 对象 key 固定为
  `<image|video>/<config-key-sha256>/<content-sha256>.webp`，客户端不能提交
  bucket、key 或外部 URL。

`STORAGE_ENDPOINT` 非空时使用现有 S3 兼容 Provider；为空时使用
`LOCAL_STORAGE_PATH`，默认 `./storage`。两种模式共享相同的内容、引用和权限校验。
头像、模型封面与网站 Logo 可以共用一个私有系统公开资产 bucket。推荐 key 命名空间为
`avatars/<user-id>-<timestamp>.<ext>`、
`<image|video>/<config-key-sha256>/<content-sha256>.webp` 和
`logo/<content-sha256>.<png|svg|ico>`。读取 Route 先按 bucket 白名单，再按 key
命名空间选择唯一资产校验器，不能因为共桶而跳过模型封面或 Logo 的严格格式校验。
历史生成器写入的 `<user-id>-<timestamp>.<jpg|jpeg|png|gif|webp>` 头像 key 继续兼容
读取和归属校验；共桶中的其他未知根目录或 key 一律拒绝。

`generations` 必须与上述三个公开资产域全部隔离；任一公共资产配置与生成内容 bucket
重叠时，封面保存、Logo 上传、公开目录和存储读取均 fail-closed。合并部署仍保留三个
设置键以兼容旧环境，只需把 `NEXT_PUBLIC_AVATARS_BUCKET_NAME`、
`MODEL_MARKETPLACE_ASSETS_BUCKET_NAME`、`SITE_ASSETS_BUCKET_NAME` 配成同一个已创建的
bucket。头像展示 URL 固定使用 `_avatars` 逻辑别名，由读取 Route 以不可缓存的 307
跳转映射到最新运行时 bucket；真实 bucket URL 仍使用长缓存，因此修改头像 bucket 不再
依赖重新构建 Web 镜像，也不会让头像请求反复读取对象存储。`_avatars` 是系统保留名称，
不能配置为任一真实 bucket。

匿名读取只开放系统公开资产 bucket；模型 WebP 与 Logo 必须满足上述内容寻址格式，且不
允许缩略图参数，响应使用一年 `immutable` 缓存并设置 `nosniff`。generations bucket
仍要求签名 URL 或第一方会话归属校验，公开资产规则不能扩展到该 bucket。内置默认封面
和品牌图标随 Web 应用发布，来源与许可见
[model-marketplace-assets.md](model-marketplace-assets.md)。

## 缓存与故障行为

- 单模型保存提交后失效系统设置缓存；失效失败只记录结构化告警，数据库仍是真相，旧值
  可能在缓存有效期内短暂可见；
- 自定义封面写入失败或移除前存储预检失败会回滚配置，保留原引用；提交后清理无引用旧
  对象失败只留下孤儿并告警，不回滚已生效配置；
- 公开目录依赖运行时目录、价格或配置失败时，binding 返回稳定 `not_ready`，页面展示
  暂不可用状态，不泄露后端成员、凭据或底层错误；
- 所有模型被显式隐藏时返回 `{ items: [] }`，这是正常 ready-empty，不是依赖故障；
- 未配置自定义封面时使用本地默认封面；浏览器加载自定义封面失败时只回退一次类别默认
  封面，避免错误重试循环。
