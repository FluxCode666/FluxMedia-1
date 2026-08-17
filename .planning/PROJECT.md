# FluxMedia

## What This Is

FluxMedia 是面向创作者和平台运营人员的 AI 图像、视频生成平台。产品通过统一模型配置、
供应商后端池、积分账务和管理后台，把多种媒体能力收敛为可运营、可审计的 Web 服务。

## Core Value

用户和运营人员能够通过清晰、安全、稳定的入口使用并管理真实可用的媒体生成能力。

## Business Context

- **Customer**: 使用 AI 媒体生成的创作者，以及维护模型、供应商和账务的运营人员
- **Revenue model**: 预付积分与按实际生成用量结算
- **Success metric**: 生成任务可成功完成且每笔用量能够被准确结算、追踪和恢复
- **Strategy notes**: 现行产品与架构计划索引见 `docs/MEMORY.md` 和 `docs/plan/`

## Requirements

### Validated

- 已支持图片与视频生成，并通过统一管线、任务状态和历史记录对外提供能力
- 已支持模型配置和公开模型广场，管理端可查看并按权限编辑模型配置
- 已支持统一媒体后端成员与分组，运行时按能力、优先级、并发和健康状态调度
- 已支持 Better Auth 会话、后台角色分层以及 Action、Route、UOL 的多层授权
- 已支持积分双重记账、支付履约、退款和幂等恢复

### Active

- [ ] 模型配置从系统设置页签拆分为独立后台菜单页面
- [ ] 账号池从系统设置页签拆分为独立后台菜单页面，并对外改称供应商管理
- [ ] 供应商管理中的分组页签拆分为独立的分组管理后台菜单页面，供应商管理只承载供应商账号
- [ ] 新页面继续遵循现有 observer_admin、admin、super_admin 的读取和写入权限
- [ ] 中英文菜单文案、路由状态、旧分组页签迁出和聚焦测试与三个独立页面保持同步

### Out of Scope

- 重命名 `image-backend-pool` 内部领域、数据库表或 UOL operation — 本次仅调整产品入口与展示语义
- 修改供应商调度、模型能力、价格或账务规则 — 与菜单拆分无关且风险较高
- 引入新的 UI 组件库或导航框架 — 继续复用现有 dashboard sidebar 与 `@repo/ui`

## Context

- 模型配置和供应商账号已从 `admin/settings` 拆出；供应商管理仍把供应商账号和分组放在同一客户端页签中，导致分组的 URL、菜单语义和权限入口不独立。
- observer_admin 已能只读查看模型配置与账号池；admin 可管理供应商，super_admin 额外管理系统设置。
- 管理端 sidebar 位于 `apps/web/src/features/dashboard/components/sidebar.tsx`，页面按本地化 App Router 组织。
- 代码库地图位于 `.planning/codebase/`，现行项目约束以根 `AGENTS.md` 为最高优先级。

## Constraints

- **Tech stack**: 保持 Next.js 16 App Router、React 19、TypeScript strict 与现有目录组织
- **Security**: 页面菜单不作为授权边界；每个新路由继续读取实时角色并在服务端重定向未授权用户
- **UI**: 优先复用 `@repo/ui` 和现有面板，不复制模型配置或供应商管理实现
- **Scope**: 只做页面拆分、导航、文案和必要测试，不改变底层 operation、分组数据、调度或账务事实
- **Quality**: 聚焦测试、Web typecheck、Web lint 必须通过，核心权限边界需要可验证

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 使用独立 App Router 页面承载模型配置与供应商管理 | URL、菜单激活和权限边界比设置页签更清晰 | Pending |
| 产品文案使用“供应商管理”，内部领域继续保留 image-backend-pool | 避免为展示命名制造高风险跨层重构 | Pending |
| 系统设置页只保留系统设置与推广奖励 | 让高敏设置入口与日常模型、供应商运营分离 | Pending |
| 使用独立 App Router 页面承载分组管理，供应商管理只保留供应商账号 | 分组筛选、分页、计费覆盖与写操作需要可直达、可激活且可审计的入口 | Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. What This Is still accurate? Update if drifted

**After each milestone**:
1. Full review of all sections
2. Core Value check
3. Audit Out of Scope reasons
4. Update Context with current state

---
*Last updated: 2026-08-18 after Phase 01 scope increment*
