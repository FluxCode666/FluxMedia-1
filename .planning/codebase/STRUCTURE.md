# 目录结构

**分析日期：** 2026-08-17

## 顶层目录

| 路径 | 用途 |
|---|---|
| `apps/web/` | Next.js 主应用、管理端、API 与页面功能 |
| `packages/shared/` | 鉴权、UOL、账务、存储、支付和领域服务 |
| `packages/database/` | Drizzle schema、数据库连接与迁移脚本 |
| `packages/ui/` | 可复用 shadcn/Radix UI 组件与工具 |
| `packages/integration-tests/` | PostgreSQL、Redis 与端到端边界测试 |
| `services/` | 独立 Go 中转服务 |
| `drizzle/` | 受版本控制的数据库迁移 |
| `docs/` | 产品、运维、计划与持久化项目记忆 |

## Web 应用放置规则

- 新页面放在 `apps/web/src/app/[locale]/(dashboard)/dashboard/...`，与现有路由组保持一致。
- 页面专用 loading 骨架与页面位于同一路由目录，如 `admin/status/loading.tsx`。
- 管理端功能 UI 放在 `apps/web/src/features/<feature>/`，公共导出用该 feature 的 `index.ts`。
- 导航和 dashboard 壳层在 `apps/web/src/features/dashboard/`。
- 本地化消息在 `apps/web/messages/zh.json` 与 `apps/web/messages/en.json` 同步维护。

## 共享包放置规则

- 新的 transport-neutral 功能先放入 `packages/shared/src/uol/operations/`，并从 UOL index 注册。
- 共享纯函数及 DB-free 测试放在同一领域目录，例如 `packages/shared/src/video-generation/`。
- 数据库 schema 或连接变更在 `packages/database/src/`；手写迁移放在 `drizzle/` 并登记 journal。
- 复用 UI 控件应添加到 `packages/ui/src/components/` 并在 `packages/ui/package.json` exports 中公开。

## 命名与导入

- Web 包内使用 `@/` 别名；跨包使用 `@repo/<package>`。
- 模块文件名使用 kebab-case；React 组件使用 PascalCase 导出。
- 页面路径使用小写、连字符段，例如 `model-configuration`。
- 测试与被测模块同目录，采用 `<module>.test.ts` 或 `<module>.test.tsx`。

---
*最后分析：2026-08-17*
