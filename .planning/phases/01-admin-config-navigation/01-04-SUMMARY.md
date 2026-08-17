---
phase: 01-admin-config-navigation
plan: "04"
subsystem: ui
tags: [nextjs, react, next-intl, vitest, dashboard-navigation, image-backend-pool]
requires:
  - phase: 01-03
    provides: "独立的 supplier-groups 路由、分组页面文案与双路由刷新契约"
provides:
  - "只承载供应商账号操作的供应商管理面板"
  - "三个后台角色可发现的独立分组管理菜单与本地化 active 路由"
  - "中文侧栏从消息键到移动 Sheet 关闭行为的 jsdom 渲染契约"
affects: [dashboard-navigation, image-backend-pool, supplier-groups]
actuals:
  tokens: 8394
  tasks: 3
  commits: 6
tech-stack:
  added: []
  patterns:
    - "供应商账号面板只保留成员表单所需的分组辅助快照，分组管理交由独立页面承载"
    - "角色菜单内部标题通过 Dashboard.nav 消息键在真实侧栏统一本地化"
key-files:
  created:
    - "apps/web/src/features/dashboard/components/sidebar.test.ts"
  modified:
    - "apps/web/src/features/image-backend-pool/admin-panel.tsx"
    - "apps/web/src/features/image-backend-pool/admin-pool-components.test.ts"
    - "apps/web/src/features/dashboard/sidebar-navigation.ts"
    - "apps/web/src/features/dashboard/sidebar-navigation.test.ts"
    - "apps/web/src/features/dashboard/navigation-i18n-contract.test.ts"
    - "apps/web/src/features/dashboard/components/sidebar.tsx"
    - "apps/web/messages/en.json"
    - "apps/web/messages/zh.json"
key-decisions:
  - "供应商管理忽略旧 poolTab=groups 查询而不重定向，避免旧 URL 恢复或隐式跳转到分组工作流。"
  - "分组入口继续只影响发现性，页面守卫和既有 Action/UOL 保持最终授权边界。"
patterns-established:
  - "DOM 测试文件使用 .test.ts，并在文件内声明 jsdom，确保 Web Vitest 实际收集。"
requirements-completed: [NAV-05, NAV-06, PRES-04, VER-01, VER-03, VER-04]
coverage:
  - id: D1
    description: "供应商管理在默认与旧 poolTab=groups URL 下都只提供供应商账号功能。"
    requirement: NAV-06
    verification:
      - kind: automated_ui
        ref: "apps/web/src/features/image-backend-pool/admin-pool-components.test.ts#默认供应商管理 URL 与旧分组查询 URL 只展示供应商账号管理"
        status: pass
    human_judgment: false
  - id: D2
    description: "observer_admin、admin 与 super_admin 都有相邻的独立分组管理菜单，且本地化深层路由正确激活。"
    requirement: NAV-05
    verification:
      - kind: unit
        ref: "apps/web/src/features/dashboard/sidebar-navigation.test.ts#sidebar navigation"
        status: pass
    human_judgment: false
  - id: D3
    description: "中文 observer_admin 侧栏将 Group Management 渲染为分组管理，并在移动链接点击后关闭 Sheet。"
    requirement: PRES-04
    verification:
      - kind: automated_ui
        ref: "apps/web/src/features/dashboard/components/sidebar.test.ts#DashboardSidebar"
        status: pass
    human_judgment: false
duration: 9m
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 04: 供应商管理收敛与分组导航接入 Summary

**供应商页面已收敛为账号专用管理面板，独立分组管理路由已面向后台角色接入双语侧栏并由中文 DOM 契约验证。**

## Performance

- **Duration:** 9m
- **Started:** 2026-08-17T17:12:00Z
- **Completed:** 2026-08-17T17:21:25Z
- **Tasks:** 3/3
- **Files modified:** 10

## Accomplishments

- 删除供应商管理面板中的分组 Tabs、筛选、分页、表单与删除交互；成员表单继续使用分组和模型辅助快照。
- 旧 `/dashboard/admin/suppliers?poolTab=groups` 不重定向也不驱动分组功能，默认与旧 URL 都由 DOM 回归测试锁定为账号管理。
- observer_admin、admin、super_admin 均获得紧邻供应商管理的分组管理菜单；中文实际渲染“分组管理”并保留移动 Sheet 关闭行为。

## Task Commits

每个 TDD 任务均按 RED/GREEN 独立提交：

1. **Task 1: 收敛供应商管理为成员专用面板并停用旧分组查询入口** - `1c3c7ca9` (test), `07b4b7df` (feat)
2. **Task 2: 接入分组管理角色菜单与双语消息契约** - `2face364` (test), `56c1a513` (feat)
3. **Task 3: 连接 getNavTitle 映射并锁定中文侧栏真实渲染** - `b3110d6c` (test), `3d68aa63` (feat)

## Files Created/Modified

- `apps/web/src/features/image-backend-pool/admin-panel.tsx` - 供应商账号专用面板，保留成员表单依赖的辅助分组快照。
- `apps/web/src/features/image-backend-pool/admin-pool-components.test.ts` - 默认与旧查询 URL 的面板职责回归测试。
- `apps/web/src/features/dashboard/sidebar-navigation.ts` - 三个后台角色的分组管理菜单项。
- `apps/web/src/features/dashboard/sidebar-navigation.test.ts` - 角色菜单顺序和分组深层路径 active 测试。
- `apps/web/src/features/dashboard/navigation-i18n-contract.test.ts` 与 `apps/web/messages/*.json` - 分组管理中英文导航和页面消息契约。
- `apps/web/src/features/dashboard/components/sidebar.tsx` 与 `sidebar.test.ts` - 标题消息映射及中文侧栏 jsdom 渲染测试。

## Decisions Made

- 保留无效的旧 `poolTab=groups` 查询参数而不重定向；供应商页面始终渲染账号管理，分组工作流只经独立路由进入。
- 菜单继续只负责发现性，分组页面服务端守卫与既有 Action/UOL 仍是写入权限边界。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 使用可被 Vitest 收集的侧栏 DOM 测试文件名**
- **Found during:** Task 3（连接 getNavTitle 映射并锁定中文侧栏真实渲染）
- **Issue:** Web Vitest 仅收集 `src/**/*.test.ts`，计划中的 `sidebar.test.tsx` 会被静默忽略。
- **Fix:** 新增 `sidebar.test.ts` 并同步更新计划中的文件声明和验证命令。
- **Files modified:** `apps/web/src/features/dashboard/components/sidebar.test.ts`、`01-04-PLAN.md`
- **Verification:** 聚焦测试和 Turbo 全量测试均报告该文件已执行。
- **Committed in:** `b3110d6c`（测试）与后续总结提交。

**2. [Rule 1 - Bug] 阻止 jsdom 测试点击链接时发起无关文档导航**
- **Found during:** Task 3（连接 getNavTitle 映射并锁定中文侧栏真实渲染）
- **Issue:** 测试中的 Link mock 会让 jsdom 尝试实际文档导航，输出无关诊断。
- **Fix:** mock 在调用移动 Sheet 关闭回调前阻止默认导航。
- **Files modified:** `apps/web/src/features/dashboard/components/sidebar.test.ts`
- **Verification:** 侧栏 jsdom 测试通过且不再输出导航诊断。
- **Committed in:** `3d68aa63`。

---

**Total deviations:** 2 auto-fixed（2 个 Rule 1 测试正确性问题）。
**Impact on plan:** 修复确保 DOM 契约真实收集且诊断稳定，未改变产品范围、权限、UOL、数据库或调度。

## Issues Encountered

- `pnpm --filter @repo/web lint` 与 `pnpm turbo lint` 均成功，但仍报告 16 条既有非阻断 Biome 警告；这些警告不属于本计划文件，已保留在 phase 的 `deferred-items.md`。

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 01 的供应商账号与分组管理页面、导航、权限边界和自动化回归覆盖已经闭合。
- 仍可在已认证环境中按计划的人工作业验证展开、折叠和移动侧栏的视觉状态；自动化 DOM 契约已覆盖文案、href、active 与移动关闭行为。

---
*Phase: 01-admin-config-navigation*
*Completed: 2026-08-17*

## Self-Check: PASSED

- 8 个关键实现、测试与总结文件均存在。
- 6 个 Task 的 RED/GREEN 提交均可从 Git 历史检索。
