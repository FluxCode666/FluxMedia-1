# 测试策略

**分析日期：** 2026-08-17

## 单元测试

- `apps/web/vitest.config.ts` 使用 Node 环境并收集 `apps/web/src/**/*.test.ts`。
- `packages/shared` 使用 Vitest 运行 DB-free 领域和 UOL 契约测试。
- 纯函数测试与实现同目录，例如 `apps/web/src/features/model-configuration/model-configuration-view-model.test.ts`。
- UI DOM 契约测试在需要时显式声明 jsdom，例如 `apps/web/src/features/image-backend-pool/admin-pool-components.test.ts`。

## 路由与权限测试

- 页面测试通过 `vi.mock` 隔离 session、role server、操作读取和重定向。
- 参考 `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/operations/page.test.ts` 测试未授权或禁用账号在读取敏感数据前被重定向。
- 新后台页面应至少覆盖访问角色边界，避免仅靠 sidebar 可见性防护。

## 集成与运维测试

- `packages/integration-tests/` 包含 PostgreSQL、Redis、媒体后端池、账务恢复与迁移边界测试。
- Playwright 用于少量端到端运营页面检查，配置和脚本在该包内。
- Go 服务采用 `go test ./...`，部署契约用 shell 测试校验。

## 运行顺序

```bash
pnpm --filter @repo/web exec vitest run <focused-tests>
pnpm --filter @repo/web typecheck
pnpm --filter @repo/web lint
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
```

## 质量要求

- 修复缺陷先写会失败的复现测试，再修实现。
- 不使用 skip、弱断言或注释断言制造假绿。
- 涉及积分、鉴权、幂等、API 或供应商边界的改动必须覆盖成功、失败、边界和重复请求场景。

---
*最后分析：2026-08-17*
