# Next.js RPC 与 JSON 接口清单

本次扫描通过 TypeScript 导入关系识别浏览器端实际调用的 `next-safe-action`。仓库当前有 25 个 Server Action 文件、112 个导出；其中 79 个导出被客户端组件导入。服务端页面调用和 Better Auth 自带的 JSON 请求没有计入浏览器 RPC。

## 已转换为 Go JSON

以下调用已经移除 `next-safe-action` 浏览器传输，浏览器发送普通 JSON，请求经 Next 同源路径 `/api/go/*` 转发到 Go backend：

| 客户端功能 | HTTP 接口 | Go 行为 |
| --- | --- | --- |
| 更新资料 | `POST /api/auth/update-user` | 当前会话校验、资料字段校验、仅更新本人 |
| 更新展示时区 | `POST /api/user/time-zone` | 当前会话校验、IANA 时区校验、更新本人偏好 |
| 侧边栏积分余额 | `GET /api/user/credits` | 当前会话校验、读取本人余额 |

成功响应使用 JSON `data` 字段；错误使用统一 `error.code`、`error.message`，并设置对应 HTTP 状态码。Go 进程仍独立监听 8080，Next 仅执行同源反向转发，不承载这些业务。

## 仍是 Next.js Server Action

以下客户端功能还没有对应的 Go 业务实现，因此暂时保留 RPC：图片生成与历史、图片后端池和模型配置、支付/钱包、推广看板、API Key 管理、工单和公告、系统设置、运营/数据看板、管理员用户管理、文件签名上传，以及其余 dashboard 刷新操作。清单中的 79 个客户端 Action 里，除上表 3 个外仍有 76 个需要资源化 JSON API 和 Go 业务实现。

不能仅把这些 Action 包装成按名称分发的 JSON 代理来宣称迁移完成；每个资源接口仍需明确输入输出、角色边界、归属校验和分页契约。

## 本地配置

开发环境把 `GO_BACKEND_URL=http://localhost:8080` 写入根环境；生产 Compose 的 web 服务使用 `http://backend:8080`。前端请求始终使用 `/api/go/...`，因此浏览器不会直接连接 Redis 或 PostgreSQL。
