---
phase: "01"
name: "后台配置入口拆分"
created: 2026-08-17
---

# Phase 1: 后台配置入口拆分 — Context

## Decisions

- 模型配置与供应商管理使用独立 App Router 页面和独立侧栏菜单；系统设置页只保留系统设置与推广奖励页签。
- 对外文案使用“供应商管理 / Supplier Management”；`image-backend-pool` operation、数据库表、调度和服务层内部命名保持不变。
- 独立页面复用现有 `ModelConfigurationPanel` 与 `ImageBackendPoolAdminPanel`，不重写模型或供应商业务逻辑。
- `observer_admin` 可只读查看两个独立页面；`admin` 与 `super_admin` 继续使用现有写权限；系统设置只允许 `super_admin`。
- 页面和菜单必须提供中英文文案，侧栏展开、折叠与移动 Sheet 状态都要正确显示 active 路由。

## Discretion Areas

- 独立路由采用 `/dashboard/admin/model-configuration` 与 `/dashboard/admin/suppliers`，沿用现有 locale 路由组和管理员页面守卫模式。
- 只读体验优先通过现有面板的能力/权限结果实现；若面板已由服务端动作拒绝写入，不新增平行权限系统。
- 测试优先补充导航消息契约、路由权限和页面装配测试；不为内部领域代码进行无关重命名。

## Deferred Ideas

- 供应商管理的领域模型重命名、数据迁移和调度策略调整不属于本阶段。
- 模型配置和供应商管理的业务能力扩展不属于本阶段。
