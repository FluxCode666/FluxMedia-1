---
phase: 01-admin-config-navigation
plan: "03"
subsystem: ui
tags: [nextjs, react, authorization, image-backend-pool, next-intl, vitest]
requires:
  - phase: 01-01
    provides: "受服务端守卫的供应商管理路由与既有账号池 Action/UOL 边界"
  - phase: 01-02
    provides: "本地化后台页面与角色化导航约定"
provides:
  - "独立的本地化分组管理路由、加载骨架和角色矩阵测试"
  - "复用既有分组 Action/UOL 的只读感知分组管理面板"
  - "供应商与分组写入成功后的双路由缓存失效契约"
affects: [01-04, dashboard-navigation, image-backend-pool]
actuals:
  tokens: 9508
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - "后台分组页面在读取分页与翻译前完成会话和角色守卫"
    - "共享后端池数据的管理路由由同一 mutation helper 同步重新验证"
key-files:
  created:
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/page.tsx"
    - "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/loading.tsx"
    - "apps/web/src/features/image-backend-pool/backend-group-admin-panel.tsx"
  modified:
    - "apps/web/src/features/image-backend-pool/actions.ts"
    - "apps/web/src/features/image-backend-pool/actions.test.ts"
    - "apps/web/messages/en.json"
    - "apps/web/messages/zh.json"
key-decisions:
  - "分组管理作为独立受守卫页面，继续调用既有 image-backend-pool Action/UOL。"
  - "后端池 mutation 共用双路由重新验证 helper，内部领域命名不变。"
patterns-established:
  - "独立分组页面：服务端角色守卫完成后才装配分页与客户端分组面板。"
  - "关联管理页面：成功 mutation 同时重新验证所有共享数据的路由。"
requirements-completed: [AUTH-05, AUTH-06, PRES-04, VER-04]
coverage:
  - id: D1
    description: "分组管理路由在服务端守卫后向 observer_admin、admin 与 super_admin 装配正确的只读状态。"
    requirement: AUTH-05
    verification:
      - kind: unit
        ref: "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/page.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "独立分组面板保留名称筛选、创建和计费覆盖入口，并在只读状态隐藏写入控件。"
    requirement: AUTH-06
    verification:
      - kind: unit
        ref: "apps/web/src/features/image-backend-pool/backend-group-admin-panel.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "分组与供应商账号写入成功后共同重新验证两个独立管理路由，失败与读取不刷新。"
    requirement: VER-04
    verification:
      - kind: unit
        ref: "apps/web/src/features/image-backend-pool/actions.test.ts"
        status: pass
    human_judgment: false
duration: 6m
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 03: 分组管理独立页面 Summary

**独立分组管理页面以服务端角色守卫和既有 Action/UOL 交付只读与写入边界，并在账号或分组变更后同步刷新两个管理入口。**

## Performance

- **Duration:** 6m
- **Started:** 2026-08-17T16:58:00Z
- **Completed:** 2026-08-17T17:03:42Z
- **Tasks:** 2/2
- **Files modified:** 10

## Accomplishments

- 新增 `/[locale]/dashboard/admin/supplier-groups` 路由、加载骨架和角色边界测试；observer_admin 仅获得只读面板，admin 与 super_admin 继续使用既有写入 Action/UOL。
- 新增 `BackendGroupAdminPanel`，复用分组筛选、URL 分页、创建、编辑、删除及图片、视频计费覆盖能力，不直接访问数据库或调度服务。
- 所有后端池 mutation 现在会共同重新验证供应商与分组管理路由；双语页面键提供“分组管理 / Group Management”和专用只读提示。

## Task Commits

Each task was committed atomically:

1. **Task 1: 打通分组管理页面到既有分组 Action 的完整路径** - `18192b88` (feat)
2. **Task 2: 建立分组页面双语标题与两个管理路由的刷新契约** - `a9a2bb48` (feat)

## Files Created/Modified

- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/` - 分组管理页面、骨架及服务端角色矩阵测试。
- `apps/web/src/features/image-backend-pool/backend-group-admin-panel.tsx` - 独立分组筛选、分页、列表和计费覆盖面板。
- `apps/web/src/features/image-backend-pool/actions.ts` - 成功 mutation 的双路由重新验证 helper。
- `apps/web/src/features/image-backend-pool/actions.test.ts` - 成功、失败与纯读取刷新边界测试。
- `apps/web/messages/en.json` 与 `apps/web/messages/zh.json` - 分组页面双语标题和只读提示。

## Decisions Made

- 分组页面只装配既有 Action/UOL，不创建数据库访问或平行权限模型。
- 保留 `revalidateBackendPoolPage` 内部命名，同时精确重新验证供应商和分组两个独立路由。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 更正未被 Vitest 收集的面板测试文件名**
- **Found during:** Task 1（分组管理页面完整路径）
- **Issue:** Web Vitest 的 `include` 仅匹配 `src/**/*.test.ts`，计划中的 `.test.tsx` 文件会被静默忽略。
- **Fix:** 将面板测试迁移为 `.test.ts`，并同步计划中列出的文件与验证命令。
- **Files modified:** `backend-group-admin-panel.test.ts`、`01-03-PLAN.md`
- **Verification:** Vitest 明确报告页面测试与面板测试两个测试文件均被执行。
- **Committed in:** `18192b88`

**2. [Rule 1 - Bug] 配置 React 测试环境的 act 标记**
- **Found during:** Task 2（双路由刷新契约）
- **Issue:** 全量测试会对面板测试输出 React act 环境警告，掩盖真正的测试诊断。
- **Fix:** 测试文件显式声明 React act 环境，不影响生产运行时。
- **Files modified:** `backend-group-admin-panel.test.ts`
- **Verification:** 聚焦 Vitest 运行无 act 环境警告。
- **Committed in:** `a9a2bb48`

---

**Total deviations:** 2 auto-fixed（2 个 Rule 1 测试正确性问题）。
**Impact on plan:** 两项修复均使测试实际执行且诊断可靠，不改变产品范围、UOL、数据库或调度行为。

## Issues Encountered

- 仓库级 `turbo lint` 成功，但报告了 16 个既有非阻断警告；它们不在本计划文件中，已登记为延期项。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 01-04 可接入分组管理侧栏入口，并从供应商面板移除旧的分组页签和 `poolTab=groups` 功能入口。
- 供应商与分组页面的缓存刷新、权限与双语页面键已准备完毕。

---
*Phase: 01-admin-config-navigation*
*Completed: 2026-08-17*

## Self-Check: PASSED

- 五个关键页面与面板文件均存在。
- 任务提交 `18192b88` 与 `a9a2bb48` 均可从 Git 历史检索。
- 三份聚焦测试共 18 项通过。
