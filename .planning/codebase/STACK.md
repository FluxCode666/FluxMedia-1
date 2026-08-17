# 技术栈

**分析日期：** 2026-08-17

## 运行时与工作区

- Monorepo 使用 pnpm 10 和 Turborepo 2，根脚本位于 `package.json` 与 `turbo.json`。
- 前端应用位于 `apps/web`，采用 Next.js 16 App Router、React 19、TypeScript strict。
- 共享服务位于 `packages/shared`，数据访问位于 `packages/database`，视觉基础组件位于 `packages/ui`。
- Go 辅助服务位于 `services/ab-shadow-relay` 和 `services/media-upstream-proxy`。

## Web 应用

| 技术 | 用途 | 位置 |
|---|---|---|
| Next.js 16 | App Router、路由处理与服务端渲染 | `apps/web/src/app/` |
| React 19 | 客户端交互面板 | `apps/web/src/features/` |
| TypeScript | 严格类型检查 | `apps/web/tsconfig.json` |
| Tailwind CSS 4 | 样式基础 | `apps/web/postcss.config.ts`、`packages/ui/src/globals.css` |
| next-intl 4 | 中英文路由与消息 | `apps/web/src/i18n/`、`apps/web/messages/` |
| next-safe-action | Server Action 的输入、鉴权与错误边界 | `packages/shared/src/safe-action.ts` |

## 数据与领域服务

- PostgreSQL 通过 Drizzle ORM 访问，schema 与连接入口在 `packages/database/src/`。
- 迁移存放在 `drizzle/`，数据库包也保留运行迁移及治理脚本。
- Zod 用于 UOL operation、表单、外部响应和分页输入的边界校验。
- BullMQ、Redis 与 PostgreSQL 为异步媒体任务与恢复流程提供基础设施。
- Pino、Sentry 与 Axiom 构成可选的日志和可观测性能力，缺失配置时要求优雅降级。

## UI 与文档

- `packages/ui/src/components/` 提供 shadcn/Radix 风格组件，业务界面应优先复用它们。
- 图标统一来自 `lucide-react`，通知使用 `sonner`。
- Fumadocs 与 MDX 驱动产品文档和法律页面，内容在 `apps/web/src/content/`。
- 图片与对象存储支持本地和 S3 兼容 provider，选择逻辑在 `packages/shared/src/storage/providers/`。

## 常用质量命令

```bash
pnpm turbo lint
pnpm turbo typecheck
pnpm turbo test
pnpm --filter @repo/web test
```

## 开发约束

- 新跨传输能力先注册到 `packages/shared/src/uol/`，再由 Web 绑定层适配。
- 不在业务包内复制基础 UI；需要的新控件应进入 `packages/ui`。
- 不读取或记录 `.env` 内容；环境变量名和示例由 `.env.example` 与部署样例约束。

---
*最后分析：2026-08-17*
