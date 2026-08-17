# 外部集成

**分析日期：** 2026-08-17

## 数据与认证

| 集成 | 职责 | 主要位置 |
|---|---|---|
| PostgreSQL 与 Drizzle | 业务事实、迁移和事务 | `packages/database/src/`、`drizzle/` |
| Better Auth | 会话、登录和角色读取 | `packages/shared/src/auth/` |
| next-safe-action | Web Action 的会话与参数边界 | `packages/shared/src/safe-action.ts` |

## 媒体、AI 与供应商

- 图片与视频生成通过统一领域服务与 UOL operation 组织，Web late binding 位于 `apps/web/src/server/uol-bindings/`。
- 图片后端成员和分组在 `packages/shared/src/uol/operations/image-backend-pool.ts` 注册，Web 管理能力在 `apps/web/src/features/image-backend-pool/`。
- 模型配置、模型广场及其写入绑定在 `apps/web/src/features/model-configuration/`、`apps/web/src/server/model-marketplace-binding.ts`。
- OpenAI、Adobe Firefly Direct 与可脚本化 API 上游适配器由共享包和 `apps/web/src/features/image-backend-pool/` 封装。
- 内容审核 provider 在 `packages/shared/src/moderation/`，策略应 fail-closed 地传递给调用方。

## 支付、邮件与存储

- Creem、Alipay 与其他支付契约位于 `packages/shared/src/payment/`，履约经 UOL operation 进入领域服务。
- 邮件客户端与模板在 `packages/shared/src/mail/`，支持 Resend 与 Nodemailer。
- S3 兼容与本地对象存储 provider 位于 `packages/shared/src/storage/providers/`；调用方通过统一 runtime snapshot 获取实例。

## 运维与监控

- Docker、Nginx、Certbot 与部署脚本位于 `deploy/` 和根 `Dockerfile*`。
- GitHub Actions 位于 `.github/workflows/ci.yml` 与 `.github/workflows/deploy-production.yml`。
- Sentry 在 `apps/web/sentry.*.config.ts` 装配；日志通过 `@repo/shared/logger` 输出。

## 集成边界

- 外部输入必须先经 Zod 或等效收窄后进入领域服务。
- 不向第三方请求转发浏览器的 `Authorization` 或 Cookie。
- Webhook、cron 与 API Route 应保持薄适配，并经 UOL gateway 统一处理权限、审计、幂等和错误。

---
*最后分析：2026-08-17*
