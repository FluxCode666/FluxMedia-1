---
phase: 01-admin-config-navigation
reviewed: 2026-08-17T23:36:00+08:00
depth: standard
files_reviewed: 21
files_reviewed_list:
  - apps/web/messages/en.json
  - apps/web/messages/zh.json
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/loading.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/model-configuration/page.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/admin-settings-tabs.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/settings/page.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/loading.tsx
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.test.ts
  - apps/web/src/app/[locale]/(dashboard)/dashboard/admin/suppliers/page.tsx
  - apps/web/src/features/dashboard/components/sidebar.tsx
  - apps/web/src/features/dashboard/navigation-i18n-contract.test.ts
  - apps/web/src/features/dashboard/sidebar-navigation.test.ts
  - apps/web/src/features/dashboard/sidebar-navigation.ts
  - apps/web/src/features/image-backend-pool/actions.test.ts
  - apps/web/src/features/image-backend-pool/actions.ts
  - apps/web/src/features/image-backend-pool/admin-panel.tsx
  - apps/web/src/features/image-backend-pool/admin-pool-components.test.ts
  - apps/web/src/features/model-configuration/model-configuration-panel.tsx
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-08-17T23:36:00+08:00  
**Depth:** standard  
**Files Reviewed:** 21  
**Status:** issues_found

## Summary

聚焦测试 7 个文件、40 个测试均通过；未发现新的关键安全漏洞或服务端授权绕过。但侧栏实现移除了观察管理员仍被角色能力明确授权的既有只读入口，且新页面虽添加了英文消息键，面板主体仍硬编码中文，导致英文 locale 的独立页面文案不一致。

## Warnings

### WR-01: 观察管理员丢失既有只读管理入口

**File:** `apps/web/src/features/dashboard/sidebar-navigation.ts:38-52`

**Issue:** `buildAdministrationItems("observer_admin")` 现在只返回模型配置和供应商管理，原先给观察管理员提供的全局状态、全局使用记录等入口被完全移除。`canViewGlobalUsageRecords` 仍明确把 `observer_admin` 列为查看角色，且这些页面仍存在并可通过 URL 访问，因此这不是权限收紧而是导航发现性回归：观察管理员无法从侧栏到达其仍被授权的只读功能。

**Fix:** 保留观察管理员原有的只读管理菜单（至少 `/dashboard/admin/status` 与 `/dashboard/admin/history`），并在其基础上加入两个新入口；或同步删除对应角色能力和产品需求，而不是只删除菜单项。为角色菜单测试增加这些既有入口的回归断言。

### WR-02: 英文页面仍渲染大量硬编码中文

**File:** `apps/web/src/features/model-configuration/model-configuration-panel.tsx:240-305`; `apps/web/src/features/image-backend-pool/admin-panel.tsx:585-695`

**Issue:** 新路由通过 `getTranslations` 只翻译页面标题和只读提示，但模型配置、供应商面板的描述、按钮、筛选器、统计和状态文本仍直接写死中文。`en.json`/`zh.json` 新增的 `addModel`、`addSupplier`、`saveConfiguration` 等键也没有被这些组件使用。因此访问 `/en/dashboard/admin/model-configuration` 或 `/en/dashboard/admin/suppliers` 会出现英文页面标题夹杂大段中文，违背本阶段的中英文页面呈现契约。

**Fix:** 将面板所需文案通过 props 或 `useTranslations` 注入，并把新增 CTA/保存/筛选/状态文本全部映射到 `Dashboard.pages`（或专用命名空间）中的双语键；删除未使用的键，或在组件中实际使用它们。补充英文渲染断言，避免只测试标题。

## Info

### IN-01: 新增消息键未使用

**File:** `apps/web/messages/en.json:895-898`; `apps/web/messages/zh.json:895-898`

**Issue:** `addModel`、`addSupplier`、`saveConfiguration` 只出现在消息文件中，代码中没有引用，形成死配置并掩盖实际仍硬编码的界面文案。

**Fix:** 接入面板翻译后保留并覆盖真实调用；若不再需要则删除，并用消息契约测试检查引用的键。

---

_Reviewed: 2026-08-17T23:36:00+08:00_  
_Reviewer: the agent (gsd-code-reviewer)_  
_Depth: standard_
