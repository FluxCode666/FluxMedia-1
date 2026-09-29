---
name: fluxmedia-admin-agent
description: 持有 FluxMedia 管理员 agent 令牌时，通过 /api/admin-agent/v1/* 调用线上管理功能的通用入口：环境变量、Bearer 认证、scope 自检、错误码和安全规则。执行任何线上管理员操作（例如读取或修改 API 供应商配置）前先使用本 Skill，再按功能索引进入对应的专用 Skill。
---

<!--
本文件是管理员 agent 接口的通用约定。具体功能的工作流写在各自的 Skill 中，这里只维护
认证方式、scope 清单、错误码和安全规则。不包含任何真实令牌、密钥或站点地址。
-->

# FluxMedia 管理员 agent

管理员在后台「管理 → Agent 令牌」（`/dashboard/admin/agent-tokens`）签发全局 agent
令牌。令牌以 `fmat_` 开头，能做什么由签发时勾选的授权范围（scope）决定，并继承签发人
的管理员身份。所有写操作都会记录审计日志。

## 1. 环境变量

令牌只从环境变量读取，不写入仓库、文档、命令历史或对话：

```bash
export FLUXMEDIA_BASE_URL="https://<站点域名>"
export FLUXMEDIA_ADMIN_AGENT_TOKEN="<管理员签发的 fmat_ 令牌>"
```

缺少任一变量时停止并请用户在自己的终端设置，不要让用户把令牌贴进对话。

接口根路径：

- 生产环境：`$FLUXMEDIA_BASE_URL/api/admin-agent/v1`（Nginx 把 `/api/*` 转发到 Go 后端）；
- 本地开发：直接访问 Go 后端 `http://localhost:8080/api/admin-agent/v1`，或经 Next
  开发代理 `http://localhost:3000/api/go/api/admin-agent/v1`。

所有请求都带 `Authorization: Bearer $FLUXMEDIA_ADMIN_AGENT_TOKEN`，写请求带
`Content-Type: application/json`。

## 2. 自检

每次开始工作先调用 `me`：

```bash
AUTH="Authorization: Bearer $FLUXMEDIA_ADMIN_AGENT_TOKEN"
API="$FLUXMEDIA_BASE_URL/api/admin-agent/v1"
curl -sS -H "$AUTH" "$API/me"
```

响应形如：

```json
{
  "tokenId": "...",
  "tokenName": "...",
  "scopes": ["suppliers:read"],
  "availableScopes": [
    { "id": "suppliers:read", "group": "供应商", "label": "读取供应商配置", "description": "...", "risky": false, "riskNote": "", "requires": [] }
  ],
  "user": { "id": "...", "role": "admin" }
}
```

- `scopes` 是当前令牌拥有的授权范围，按它决定能做什么；
- `availableScopes` 是服务端全部 scope 的说明，以它为准，不要依赖本文件的表格猜测；
- 任务需要的 scope 不在 `scopes` 中时，只做只读分析，把需要的 scope 告诉用户，由管理员
  重新签发令牌。不要尝试绕过。

## 3. 授权范围

| scope | 能力 | 前置 | 风险 |
| --- | --- | --- | --- |
| `suppliers:read` | 读取 API 供应商脱敏配置、适配版本和目录，用合成样例在线测试脚本 | 无 | 低 |
| `suppliers:write` | 增量修改和回滚 API 供应商配置（含 baseUrl），不能改认证方式和密钥 | `suppliers:read` | 高 |

签发时勾选某个 scope 会自动带上它的前置 scope。`suppliers:write` 可以修改 `baseUrl`，
上游请求会携带已保存的供应商密钥发往新地址，所以只在用户明确要求时才改 `baseUrl`。

## 4. 错误处理

错误响应形如 `{"error":{"code":"...","message":"...","type":"..."}}`，按 `code` 判断：

| HTTP | code | 含义与处理 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 参数不合法；按 message 修正后再试 |
| 401 | `UNAUTHORIZED` | 令牌无效、过期或已撤销；停止并请管理员重新签发 |
| 403 | `FORBIDDEN` | 签发人已失去管理员权限；停止 |
| 403 | `INSUFFICIENT_SCOPE` | 令牌缺少 message 中列出的 scope；停止写操作，告知用户 |
| 404 | `NOT_FOUND` | 资源不存在；重新列出后确认 ID |
| 409 | `VERSION_CONFLICT` 等 | 期间有人修改过数据；重新读取后基于最新数据重做 |
| 429 | `RATE_LIMITED` | 请求过快；等待后串行重试，不要并发 |
| 503 | `NOT_READY` | 服务依赖暂不可用；稍后重试，多次失败则告知用户 |

各功能的专用错误码见对应 Skill。

## 5. 安全规则

- 不打印、不回显、不保存 `FLUXMEDIA_ADMIN_AGENT_TOKEN`，命令中只引用环境变量；
- 接口永远不返回业务密钥，也不要尝试读取、推断或修改任何密钥与认证配置；
- 支持 `dryRun` 的写接口必须先预演，确认变更字段符合预期后再正式提交；
- 发生版本冲突时重新读取合并，不强行覆盖；
- 影响线上调度或流量走向的字段（地址、开关、分组、并发等）未经用户确认不修改；
- 交付时写明调用了哪些写接口、变更前后的版本号和变更字段。

## 6. 功能索引

| 功能 | 所需 scope | 专用 Skill |
| --- | --- | --- |
| 读取、测试、修改和回滚 API 供应商适配配置 | `suppliers:read` / `suppliers:write` | `write-api-upstream-adapter`，线上接口见其 `references/online-api.md` |

新的管理功能接入 agent 时，在 Go 注册表 `services/api-gateway/admin_agent_scopes.go`
追加 scope，并同步更新本文件第 3 节和第 6 节。
