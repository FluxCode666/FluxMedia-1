---
phase: "01"
name: "后台配置入口拆分"
created: 2026-08-17
---

# Phase 1: 后台配置入口拆分 — Context

## Decisions

- **D-01**: 模型配置与供应商管理使用独立 App Router 页面和独立侧栏菜单；系统设置页只保留系统设置与推广奖励页签。
- **D-02**: 对外文案使用“供应商管理 / Supplier Management”；`image-backend-pool` operation、数据库表、调度和服务层内部命名保持不变。
- **D-03**: 独立页面复用现有 `ModelConfigurationPanel` 与 `ImageBackendPoolAdminPanel`，不重写模型或供应商业务逻辑。
- **D-04**: `observer_admin` 可只读查看两个独立页面；`admin` 与 `super_admin` 继续使用现有写权限；系统设置只允许 `super_admin`。
- **D-05**: 页面和菜单必须提供中英文文案，侧栏展开、折叠与移动 Sheet 状态都要正确显示 active 路由。

## Discretion Areas

- **D-06（裁量边界）**: 独立路由采用 `/dashboard/admin/model-configuration` 与 `/dashboard/admin/suppliers`，沿用现有 locale 路由组和管理员页面守卫模式。
- **D-07（裁量边界）**: 只读体验优先通过现有面板的能力/权限结果实现；若面板已由服务端动作拒绝写入，不新增平行权限系统；测试优先补充导航消息契约、路由权限和页面装配测试；不为内部领域代码进行无关重命名。

## Scope Increment — 2026-08-18

### Locked Decisions

- **D-08**: 供应商管理中的分组必须迁出为独立后台菜单页面，使用本地化 App Router 路由 `/dashboard/admin/supplier-groups`，对外文案为“分组管理 / Group Management”。
- **D-09**: `observer_admin` 可只读访问分组管理；`admin` 与 `super_admin` 使用既有分组写入 Action/UOL；分组页面必须在读取分页、时区或装配面板前执行服务端会话和角色守卫。
- **D-10**: 供应商管理只保留供应商账号管理；分组管理独占分组筛选、分页、创建、编辑、删除和计费覆盖，`/dashboard/admin/suppliers?poolTab=groups` 不再作为分组功能入口。
- **D-11**: 分组或供应商账号 mutation 成功后必须刷新 `/dashboard/admin/suppliers` 与 `/dashboard/admin/supplier-groups`；不得重命名 `image-backend-pool`、UOL operation、数据库表或调度。
- **D-12**: 侧栏、双语消息和聚焦测试必须覆盖新分组路由、三档后台角色、面板职责拆分、旧查询参数和双页面刷新契约。

## Deferred Ideas

- 供应商管理的领域模型重命名、数据迁移和调度策略调整不属于本阶段。
- 模型配置和供应商管理的业务能力扩展不属于本阶段。
