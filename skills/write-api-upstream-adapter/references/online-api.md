<!--
本文件说明外部 agent 如何通过全局管理员 agent 令牌读取、测试、修改和回滚线上 API
供应商适配配置。只描述 /api/admin-agent/v1/* 接口契约与安全工作流，不包含任何真实
令牌、密钥或供应商地址。
-->

# 线上供应商配置 API

管理员在「管理 → Agent 令牌」（`/dashboard/admin/agent-tokens`）签发全局 agent 令牌
并勾选供应商相关授权范围后，agent 可以直接读取和修改线上 API 供应商的适配配置（路径、
模型映射、请求与响应脚本、baseUrl 等）。所有修改都会生成新的适配版本，只影响之后创建
的任务，并可回滚。

环境变量、Bearer 认证、`me` 自检、通用错误码和安全规则以项目 Skill
`fluxmedia-admin-agent` 为准，本文件只描述供应商相关接口。

## 环境变量

令牌只从环境变量读取，不写入仓库、文档、命令历史或对话：

```bash
export FLUXMEDIA_BASE_URL="https://<站点域名>"
export FLUXMEDIA_ADMIN_AGENT_TOKEN="<管理员签发的 fmat_ 令牌>"
```

- 生产环境：`$FLUXMEDIA_BASE_URL/api/admin-agent/v1/...`（Nginx 把 `/api/*` 转发到
  Go 后端）；
- 本地开发：直接访问 Go 后端 `http://localhost:8080/api/admin-agent/v1/...`，或经
  Next 开发代理 `http://localhost:3000/api/go/api/admin-agent/v1/...`。

所有请求都带 `Authorization: Bearer $FLUXMEDIA_ADMIN_AGENT_TOKEN`，写请求带
`Content-Type: application/json`。

## 权限边界

- `suppliers:read`：可以调用全部 GET 接口和脚本测试；
- `suppliers:write`（自动包含 `suppliers:read`）：可以修改名称、分组、模型、分辨率、
  开关、优先级、并发和适配配置（包括 `baseUrl`），以及回滚；
- 缺少接口所需的 scope 时返回 403 `INSUFFICIENT_SCOPE`，message 中带出所需 scope；
- 任何令牌都不能修改 `apiKey` 和 `authentication`，提交这两个字段返回 403
  `CREDENTIAL_CHANGE_FORBIDDEN`；接口永远不返回供应商密钥；
- 令牌过期、被撤销、签发人失去管理员角色后立即失效（401 或 403）；
- 请求受限流约束，429 `RATE_LIMITED` 时等待后重试，不要并发轰炸。

修改 `baseUrl` 后，上游请求会携带已保存的密钥发往新地址。只有用户明确要求且新地址
来自供应商官方文档时才修改 `baseUrl`，并在交付中单独列出旧值和新值。

## 接口清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin-agent/v1/me` | 当前令牌名称、`scopes` 和全部 `availableScopes`（无需特定 scope） |
| GET | `/api/admin-agent/v1/catalog` | 分组、尺寸配置、六操作默认路径、可改字段和上限 |
| GET | `/api/admin-agent/v1/suppliers?q=` | 供应商摘要，只列出已配置脚本的字段名 |
| GET | `/api/admin-agent/v1/suppliers/{id}` | `supplier` 脱敏详情、`editable` 可改形状、`expectedCurrentVersionId` |
| PATCH | `/api/admin-agent/v1/suppliers/{id}` | 增量修改，支持 `dryRun` |
| GET | `/api/admin-agent/v1/suppliers/{id}/versions?page=&pageSize=` | 适配版本列表（pageSize 为 10/20/50） |
| GET | `/api/admin-agent/v1/suppliers/{id}/versions/{versionId}` | 单个版本的脱敏适配配置 |
| POST | `/api/admin-agent/v1/suppliers/{id}/rollback` | 以历史版本追加新版本，支持 `dryRun` |
| POST | `/api/admin-agent/v1/script-test` | 用合成样例运行脚本，不访问上游、不产生费用 |

错误响应形如 `{"error":{"code":"...","message":"...","type":"..."}}`，按 `code` 判断。

## 工作流

### 1. 自检与读取

```bash
AUTH="Authorization: Bearer $FLUXMEDIA_ADMIN_AGENT_TOKEN"
API="$FLUXMEDIA_BASE_URL/api/admin-agent/v1"
curl -sS -H "$AUTH" "$API/me"
curl -sS -H "$AUTH" "$API/catalog"
curl -sS -H "$AUTH" "$API/suppliers?q=<名称关键字>"
curl -sS -H "$AUTH" "$API/suppliers/<id>"
```

记下详情中的 `expectedCurrentVersionId`，并以 `editable.config.operations` 为准读取
当前脚本。`me.scopes` 不包含 `suppliers:write` 时只做分析和测试，把修改建议交给
管理员。

### 2. 在线测试脚本

先按主流程写好脚本和夹具，再逐个用线上运行时测试。`script` 与 `supplierId` 二选一：
提供 `script` 测试草稿，提供 `supplierId` 测试该供应商当前已保存的脚本。

```bash
curl -sS -H "$AUTH" -H "Content-Type: application/json" -X POST "$API/script-test" \
  --data @- <<'JSON'
{
  "operation": "images.generate",
  "stage": "request",
  "script": "const body = { ...request.body }; return { body };",
  "sample": {
    "query": {},
    "body": { "model": "vendor-model", "prompt": "synthetic prompt" }
  }
}
JSON
```

- 请求阶段样例：`{ "query": {...}, "body": {...} }`；
- 响应阶段样例：`{ "statusCode": 200, "headers": {...}, "body": {...} }`；
- 成功返回 `{ "preview": ..., "source": "inline" | "supplier", "scriptEmpty", "elapsedMs" }`；
- 脚本失败只返回通用错误：422 `SCRIPT_EXECUTION_FAILED`（执行失败或输出无效）、
  503 `SCRIPT_RUNTIME_UNAVAILABLE`。运行时不返回堆栈或行号，需要缩小脚本、逐步增加
  逻辑定位问题。

长脚本建议先写入本地临时 JSON 文件，再用 `--data @file.json` 提交，避免 shell 转义。

### 3. 预演修改

PATCH 只提交要改的字段。顶层字段整体替换；`config` 内除 `operations` 外的字段整体
替换，`null` 表示恢复默认；`operations` 按操作和字段合并，只接受 `path`、
`requestScript`、`responseScript`，`null` 表示清空。

```bash
curl -sS -H "$AUTH" -H "Content-Type: application/json" -X PATCH "$API/suppliers/<id>" \
  --data @- <<'JSON'
{
  "expectedCurrentVersionId": "<详情中的值>",
  "dryRun": true,
  "reason": "适配供应商新版响应字段",
  "config": {
    "operations": {
      "images.generate": { "responseScript": "<脚本源码>" }
    }
  }
}
JSON
```

预演会执行与正式保存相同的校验（含脚本语法校验），返回 `changedFields`、
`versionCreated` 和合并后的 `editable`，但不落库。检查 `changedFields` 只包含预期字段。

### 4. 正式保存与验证

去掉 `dryRun` 再提交一次。成功后响应包含新的 `currentVersion`、`supplier` 和新的
`expectedCurrentVersionId`。随后：

1. 重新读取详情，确认脚本和路径已生效；
2. 用 `supplierId` 方式再跑一遍脚本测试；
3. 在交付中写明旧版本号、新版本号和变更字段。

409 `VERSION_CONFLICT` 表示期间有人修改过配置：重新读取详情，基于最新配置重新合并，
不要直接覆盖。

### 5. 回滚

```bash
curl -sS -H "$AUTH" "$API/suppliers/<id>/versions"
curl -sS -H "$AUTH" -H "Content-Type: application/json" -X POST "$API/suppliers/<id>/rollback" \
  --data '{"versionId":"<目标版本>","expectedCurrentVersionId":"<当前版本>","dryRun":true}'
```

预演确认 `changedFields` 后去掉 `dryRun` 正式回滚，并填写 `reason`。回滚以目标版本的
适配配置追加新版本，保留当前认证方式与密钥；运行中的任务继续使用原版本。管理员也
可以在供应商详情页的「版本历史」中回滚。

## 禁止事项

- 不打印、不回显、不保存 `FLUXMEDIA_ADMIN_AGENT_TOKEN`；
- 不尝试读取或推断供应商密钥，不提交 `apiKey`、`authentication`；
- 不用真实供应商请求验证脚本，只用 `script-test` 合成样例；
- 不跳过预演直接保存，不在版本冲突时强行覆盖；
- 未经用户确认不修改 `baseUrl`、`isEnabled`、分组或并发等影响线上调度的字段。
