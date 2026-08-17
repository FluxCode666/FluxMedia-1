---
phase: 01-admin-config-navigation
plan: "01"
subsystem: ui
tags: [nextjs, app-router, admin, authorization, vitest]
requires: []
provides:
  - "模型配置与供应商管理的独立本地化后台路由和加载骨架"
  - "observer_admin 只读展示与系统设置的 super_admin 页面边界"
  - "供应商 mutation 刷新独立 suppliers 入口"
affects: [01-02, dashboard-navigation, admin-settings]
actuals:
  tokens: 8700
  tasks: 3
  commits: 3
tech-stack:
  added: []
  patterns:
    - "服务端路由在读取分页、时区或装配客户端面板前完成会话和角色守卫"
    - "面板使用既有 UOL 能力结果和 readOnly 属性呈现只读体验"
key-files:
  created:
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.tsx"
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.tsx"
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.test.ts"
  modified:
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.tsx"
    - "apps/web/src/features/image-backend-pool/admin-panel.tsx"
    - "apps/web/src/features/image-backend-pool/actions.ts"
key-decisions:
  - "独立页面仅装配既有面板，继续由 Action/UOL 负责模型和供应商写权限。"
  - "系统设置入口收紧为 super_admin，模型配置与供应商入口不再作为其页签。"
patterns-established:
  - "后台独立页面：会话与角色守卫通过后才读取页面依赖。"
  - "用户可见供应商名称与内部 image-backend-pool 领域命名分离。"
requirements-completed: [NAV-01, NAV-02, NAV-03, AUTH-01, AUTH-02, AUTH-03, AUTH-04, PRES-01, PRES-03, VER-02]
coverage:
  - id: D1
    description: "模型配置独立路由在服务器端完成角色守卫后装配现有面板。"
    requirement: NAV-01
    verification:
      - kind: unit
        ref: "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "供应商管理独立路由向 observer_admin 传入只读状态，并展示供应商管理标题。"
    requirement: NAV-02
    verification:
      - kind: unit
        ref: "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.test.ts"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/image-backend-pool/admin-pool-components.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "系统设置仅允许 super_admin，且供应商 mutation 刷新 suppliers 路由。"
    requirement: AUTH-03
    verification:
      - kind: unit
        ref: "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.test.ts"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/image-backend-pool/actions.test.ts"
        status: pass
    human_judgment: false
duration: 5m 29s
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 01: 后台配置独立页面 Summary

**模型配置和供应商管理已拆为受服务端角色守卫的本地化后台页面，保留既有 UOL 权限与 image-backend-pool 内部领域。**

## Performance

- **Duration:** 5m 29s
- **Started:** 2026-08-17T15:05:53Z
- **Completed:** 2026-08-17T15:11:22Z
- **Tasks:** 3/3
- **Files modified:** 14

## Accomplishments

- 新增模型配置和供应商管理独立路由及 `aria-busy` loading 骨架；未登录和普通用户会在读取分页、时区或装配面板前重定向。
- observer_admin 通过模型 UOL 的 `canEdit=false` 和供应商面板的 `readOnly` 获得明确只读界面；admin 与 super_admin 的既有写入授权未改变。
- 系统设置仅保留系统设置与推广奖励两个页签，并限制为 super_admin；所有供应商 mutation 改为刷新 `/dashboard/admin/suppliers`。

## Task Commits

1. **Task 1: 打通模型配置独立页面的守卫到面板读取路径** - `9e6940de` (feat)
2. **Task 2: 装配供应商管理独立页面并保留账号池写权限边界** - `14c64cd0` (feat)
3. **Task 3: 收紧系统设置页签并修正供应商 mutation 刷新目标** - `556a2f2d` (feat)

## Files Created/Modified

- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/` - 模型配置独立页面、骨架及角色边界测试。
- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/` - 供应商管理独立页面、骨架及角色边界测试。
- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/` - super_admin 守卫、两页签装配及测试。
- `apps/web/src/features/model-configuration/model-configuration-panel.tsx` - 基于现有 `canEdit` 显示只读提示并隐藏新增入口。
- `apps/web/src/features/image-backend-pool/admin-panel.tsx` - 对外供应商标题、只读提示和只读写控件隐藏。
- `apps/web/src/features/image-backend-pool/actions.ts` - mutation 成功后刷新独立供应商页面。

## Decisions Made

- 路由层只负责实时会话、角色和页面依赖装配，不复制模型配置或供应商领域逻辑。
- 对外采用“供应商管理”文案，`image-backend-pool` operation、数据模型和调度命名保持不变。

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- 供应商面板组件测试初始错误地断言了未激活的惰性分组页签 CTA；已将断言收敛为首屏实际挂载的“新增供应商账号”入口，随后聚焦测试与 typecheck 均通过。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 01-02 可将已交付的两个独立路由接入侧栏、导航文案与 active-route 契约。
- 当前工作区保留 01-02 的侧栏、消息和导航测试改动，未包含在本计划提交中。

## Self-Check: PASSED

- 关键创建文件均存在。
- 任务提交 `9e6940de`、`14c64cd0`、`556a2f2d` 均可从 Git 历史检索。
