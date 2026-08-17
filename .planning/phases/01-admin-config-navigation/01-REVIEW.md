---
phase: 01-admin-config-navigation
reviewed: 2026-08-18T01:36:00+08:00
depth: standard
files_reviewed: 26
files_reviewed_list:
  - apps/web/messages/en.json
  - apps/web/messages/zh.json
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/loading.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/admin-settings-tabs.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/loading.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/supplier-groups/page.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/loading.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.tsx
  - apps/web/src/features/dashboard/components/sidebar.test.ts
  - apps/web/src/features/dashboard/components/sidebar.tsx
  - apps/web/src/features/dashboard/navigation-i18n-contract.test.ts
  - apps/web/src/features/dashboard/sidebar-navigation.test.ts
  - apps/web/src/features/dashboard/sidebar-navigation.ts
  - apps/web/src/features/image-backend-pool/actions.test.ts
  - apps/web/src/features/image-backend-pool/actions.ts
  - apps/web/src/features/image-backend-pool/admin-panel.tsx
  - apps/web/src/features/image-backend-pool/admin-pool-components.test.ts
  - apps/web/src/features/image-backend-pool/backend-group-admin-panel.test.ts
  - apps/web/src/features/image-backend-pool/backend-group-admin-panel.tsx
  - apps/web/src/features/model-configuration/model-configuration-panel.tsx
findings:
  critical: 1
  warning: 1
  info: 0
  total: 2
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-08-18T01:36:00+08:00
**Depth:** standard
**Files Reviewed:** 26
**Status:** issues_found

## Summary

审查了新增的三条管理路由、角色菜单、Server Action 刷新、分页 URL 状态和中英文消息。聚焦 Vitest 已通过（10 个文件、53 项断言），`@repo/web` typecheck 也通过；但现有测试没有覆盖英文页面主体文案和异步请求乱序，仍存在以下必须处理的问题。

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: 新的英文管理路由主体仍然是中文界面

**File:** `/Users/duegin/project/FluxMedia/apps/web/src/features/image-backend-pool/admin-panel.tsx:429`, `/Users/duegin/project/FluxMedia/apps/web/src/features/image-backend-pool/backend-group-admin-panel.tsx:258`, `/Users/duegin/project/FluxMedia/apps/web/src/features/model-configuration/model-configuration-panel.tsx:242`

**Issue:** 三个新独立路由只将页面标题和只读提示接到 `Dashboard.pages` 消息；面板主体仍直接输出中文（说明、按钮、筛选控件、空状态、分页标签、toast 和 aria 文案）。因此访问 `/en/dashboard/admin/suppliers`、`/en/dashboard/admin/supplier-groups` 或 `/en/dashboard/admin/model-configuration` 时，标题为英文但可操作界面为中文，违反本阶段的双语页面契约。当前 `navigation-i18n-contract.test.ts` 只检查消息键和标题，无法发现该回归。

**Fix:** 为三个面板建立完整的消息命名空间并在客户端通过 `useTranslations` 获取所有用户可见字符串（包括 aria、加载、错误和 toast 文案）；或由路由统一传入已本地化的文案对象。补充 en/zh DOM 测试，断言英文路由不包含这些中文操作标签，且关键控件的可访问名称已本地化。

## Warnings

### WR-01: 筛选或分页快速切换时旧响应可以回写当前列表和 URL

**File:** `/Users/duegin/project/FluxMedia/apps/web/src/features/image-backend-pool/admin-panel.tsx:192`, `/Users/duegin/project/FluxMedia/apps/web/src/features/image-backend-pool/backend-group-admin-panel.tsx:114`, `/Users/duegin/project/FluxMedia/apps/web/src/features/model-configuration/model-configuration-panel.tsx:109`

**Issue:** 三个面板在 URL 参数变化时都会发起新的异步列表请求，但成功回调没有取消前序请求，也没有用请求序号或当前参数比对来丢弃旧响应。若先请求 A，再快速筛选到 B，而 A 在 B 之后返回，A 会覆盖 B 的 `memberPage`、`groupPage` 或 `pageResult`；前两个面板还会按 A 的页码执行 `router.replace`。用户会在地址栏保留 B 的筛选条件时看到 A 的结果，或被跳回旧页码。现有组件测试只断言初始 DOM，不模拟乱序完成。

**Fix:** 在每次发起列表请求时递增 `useRef` 中的 request id，并在完成后仅当 id 仍是最新值时更新状态和调用 `router.replace`；或者使用支持取消的请求机制并在 effect cleanup 中中止旧请求。为三个列表至少添加一个乱序响应测试，验证旧请求完成不会改写新筛选条件对应的状态或 URL。

---

_Reviewed: 2026-08-18T01:36:00+08:00_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
