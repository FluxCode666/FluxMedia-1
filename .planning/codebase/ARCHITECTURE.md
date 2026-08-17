# 架构

**分析日期：** 2026-08-17

## 总体分层

FluxMedia 是以 `apps/web` 为入口的 Turborepo 单体仓库。Next.js 路由负责页面、Route Handler 与首屏装配；领域逻辑和传输无关 operation 收敛在 `packages/shared`；数据库包只承载 schema、连接和迁移。

```text
Next.js 页面 / Action / Route Handler
        ↓ 薄适配
UOL Operation Registry 与 invokeOperation
        ↓ 领域服务
共享业务模块与仓储端口
        ↓
Drizzle / PostgreSQL、Redis、存储与供应商 API
```

## Web 层

- 本地化 App Router 页面在 `apps/web/src/app/[locale]/`。
- 功能模块按业务置于 `apps/web/src/features/<domain>/`，页面只装配会话、角色、URL 输入和组件。
- 生产 binding 集中在 `apps/web/src/server/uol-bindings/`；`apps/web/src/server/uol-init.ts` 负责初始化。
- `apps/web/src/i18n/routing.ts` 是本项目本地化导航入口；页面内导航不要直接绕过它。

## 共享领域层

- UOL 核心位于 `packages/shared/src/uol/`，operation 定义位于 `packages/shared/src/uol/operations/`。
- 鉴权 Action builder 位于 `packages/shared/src/safe-action.ts`，按 `actionClient`、`protectedAction`、`adminAction` 等层级提供上下文。
- 账务真实来源为 credits transaction；媒体后端池、模型配置、支付和审核都有独立领域契约。

## 后台管理数据流

1. `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/` 页面读取 session 和角色。
2. 管理组件调用 feature 内的 Server Action 或安全 Route。
3. Action 初始化 UOL，并以当前 principal 调用对应 operation。
4. binding 将 operation 连接到 feature service、repository 和共享领域契约。
5. 客户端只保存筛选、分页、对话框等 UI 状态，不直接访问数据库。

## 关键不变量

- 图像生成必须汇入 `runImageGenerationForUser`。
- 扣费、发放、退款等操作使用 source reference 或 client request id 维持幂等。
- 服务函数自行管理 `db.transaction`，调用方不能包装嵌套外层事务。
- 供应商账号、模型能力与定价配置遵循统一 operation 与角色授权，不把页面菜单当作安全边界。

---
*最后分析：2026-08-17*
