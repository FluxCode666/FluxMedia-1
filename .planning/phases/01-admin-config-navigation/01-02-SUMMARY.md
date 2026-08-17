---
phase: 01-admin-config-navigation
plan: 02
subsystem: ui
tags: [nextjs, sidebar, navigation, i18n, vitest]
requires:
  - phase: 01-admin-config-navigation
    provides: 独立模型配置、供应商管理页面及系统设置权限收紧
provides:
  - 角色化后台侧栏菜单
  - locale 感知的最长路径 active helper
  - 中英文模型配置与供应商管理导航契约
affects: [admin-navigation, phase-01-verification]
actuals:
  tokens: 5227
  tasks: 2
  commits: 2
tech-stack:
  added: []
  patterns:
    - 纯函数生成角色菜单并与展示层解耦
    - 去 locale 前缀后按最长 href 匹配 active 路由
key-files:
  created:
    - apps/web/src/features/dashboard/sidebar-navigation.ts
    - apps/web/src/features/dashboard/sidebar-navigation.test.ts
  modified:
    - apps/web/src/features/dashboard/components/sidebar.tsx
    - apps/web/messages/en.json
    - apps/web/messages/zh.json
    - apps/web/src/features/dashboard/navigation-i18n-contract.test.ts
key-decisions:
  - 观察管理员仅显示模型配置与供应商管理，系统设置仅对 super_admin 暴露。
  - 侧栏所有状态共享 locale 规范化和最长路径 active 判定；菜单可见性不替代服务端授权。
requirements-completed: [NAV-04, PRES-02, VER-01, VER-03]
coverage:
  - id: D1
    description: 角色化 Administration 菜单提供模型配置、供应商管理和超管系统设置入口
    requirement: NAV-04
    verification:
      - kind: unit
        ref: apps/web/src/features/dashboard/sidebar-navigation.test.ts
        status: pass
      - kind: unit
        ref: apps/web/src/features/dashboard/navigation-i18n-contract.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: 展开、折叠和移动侧栏复用最长路径 active 计算并关闭移动 Sheet
    requirement: PRES-02
    verification:
      - kind: unit
        ref: apps/web/src/features/dashboard/sidebar-navigation.test.ts
        status: pass
      - kind: manual_procedural
        ref: 启动 Web 后检查桌面展开、桌面折叠和移动 Sheet 的 active 与关闭行为
        status: unknown
    human_judgment: true
    rationale: 视觉状态和移动 Sheet 交互需要浏览器运行时确认。
  - id: D3
    description: zh/en Dashboard.nav 与 Dashboard.pages 锁定模型配置和供应商管理精确文案
    requirement: VER-01
    verification:
      - kind: unit
        ref: apps/web/src/features/dashboard/navigation-i18n-contract.test.ts
        status: pass
    human_judgment: false
  - id: D4
    description: Web 聚焦页面测试、typecheck 和 lint 通过
    requirement: VER-03
    verification:
      - kind: other
        ref: pnpm --filter @repo/web exec vitest run 导航与三个后台页面测试
        status: pass
      - kind: other
        ref: pnpm --filter @repo/web typecheck
        status: pass
      - kind: other
        ref: pnpm --filter @repo/web lint
        status: pass
    human_judgment: false
duration: 7m
completed: 2026-08-17
status: complete
---

# Phase 01 Plan 02 Summary

**角色化后台侧栏已接入模型配置与供应商管理页面，并统一中英文文案和 locale 路径 active 契约。**

## Performance

- **Duration:** 7 分钟
- **Started:** 2026-08-17T15:13:28Z
- **Completed:** 2026-08-17T15:20:57Z
- **Tasks:** 2
- **Files modified:** 6（另创建 2 个导航纯函数与测试文件）

## Accomplishments

- 抽出 DB-free 的角色菜单构建和最长前缀 active helper，观察管理员仅获得两个只读入口，系统设置仅供 super_admin。
- 桌面展开、折叠和移动 Sheet 共用导航内容及 active 结果，保留折叠 tooltip、点击展开和移动点击关闭行为。
- 同步 zh/en 的 Dashboard.nav 与 Dashboard.pages 文案，移除旧账号池外显导航键，并补充精确契约测试。

## Task Commits

1. **Task 1: 打通角色化侧栏到独立页面的 active 导航路径** - `478a22fa`
2. **Task 2: 锁定中英文导航文案与阶段聚焦验证** - `98a2fc2c`

## Files Created/Modified

- `apps/web/src/features/dashboard/sidebar-navigation.ts` - 角色菜单和路径规范化/最长匹配纯函数。
- `apps/web/src/features/dashboard/sidebar-navigation.test.ts` - 角色、locale 和深层路径测试。
- `apps/web/src/features/dashboard/components/sidebar.tsx` - 接入统一菜单与 active helper。
- `apps/web/messages/en.json`、`apps/web/messages/zh.json` - 双语导航、页面标题和只读/CTA 文案。
- `apps/web/src/features/dashboard/navigation-i18n-contract.test.ts` - 文案、角色入口和旧键回归契约。

## Decisions Made

- 观察管理员只显示模型配置和供应商管理；普通 admin 不显示系统设置；super_admin 额外显示系统设置。
- 保留内部 `image-backend-pool` 领域标识，仅替换用户可见标题为供应商管理。

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] 修正观察管理员菜单超出阶段范围**
- **Found during:** Task 1
- **Issue:** 既有未提交实现还显示全局状态和全局使用记录，与计划要求的观察管理员两个独立入口不一致。
- **Fix:** 观察管理员菜单收敛为模型配置和供应商管理。
- **Files modified:** `apps/web/src/features/dashboard/sidebar-navigation.ts`、`apps/web/src/features/dashboard/sidebar-navigation.test.ts`
- **Verification:** 角色导航测试和页面聚焦测试通过。
- **Committed in:** `478a22fa`

**2. [Rule 3 - Blocking] 统一 active helper 调用签名**
- **Found during:** Task 1
- **Issue:** 实现参数顺序与计划公开签名不一致，隐藏调用方容易误用。
- **Fix:** 统一为 `findMostSpecificActiveHref(pathname, items)` 并同步侧栏和测试。
- **Files modified:** `apps/web/src/features/dashboard/sidebar-navigation.ts`、`apps/web/src/features/dashboard/sidebar-navigation.test.ts`、`apps/web/src/features/dashboard/components/sidebar.tsx`
- **Verification:** 最长路径和 locale 前缀测试通过，Web typecheck 通过。
- **Committed in:** `478a22fa`

**Total deviations:** 2 auto-fixed（Rule 1: 1，Rule 3: 1）
**Impact on plan:** 均为计划契约对齐，无架构或范围扩张。

## Issues Encountered

`pnpm --filter @repo/web lint` 通过；仓库仍报告既有 16 条 warning，未涉及本计划文件，未修改。

## User Setup Required

None - 无外部服务配置要求。

## Next Phase Readiness

导航代码、双语消息和页面聚焦测试已就绪；剩余移动端和折叠态视觉行为按计划由浏览器人工验收。

---
*Phase: 01-admin-config-navigation*
*Completed: 2026-08-17*

## Self-Check: PASSED

- 摘要文件存在。
- 任务提交 `478a22fa` 和 `98a2fc2c` 均存在于 Git 历史。
- 聚焦测试、页面测试、typecheck 和 lint 均已完成验证。
