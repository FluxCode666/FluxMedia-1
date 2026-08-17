---
phase: 01-admin-config-navigation
verified: 2026-08-17T16:00:34Z
status: human_needed
score: 4/5 must-haves verified
behavior_unverified: 1
behavior_unverified_items:
  - truth: "展开、折叠和移动 Sheet 中的真实 active 样式与关闭交互一致。"
    test: "以三档后台角色在中英文界面访问模型配置和供应商管理，并切换桌面展开、桌面折叠与移动 Sheet。"
    expected: "当前菜单显示 active 背景和左侧指示；移动端点击入口后 Sheet 关闭；observer_admin 不显示系统设置。"
    why_human: "纯函数和组件连线测试可证明路径计算与回调存在，无法检查浏览器中的 CSS 状态和真实 Sheet 行为。"
---

# Phase 01: 后台配置入口拆分验证报告

**阶段目标：** 模型配置和供应商管理成为独立、安全、可测试的后台菜单页面，同时保留系统设置的高敏权限边界与现有内部领域命名。

**验证时间：** 2026-08-17T16:00:34Z

**状态：** human_needed

## 目标达成情况

### 可观察事实

| # | 事实 | 状态 | 证据 |
|---|---|---|---|
| 1 | 有权后台角色可从本地化侧栏进入独立的模型配置和供应商管理页面，所有侧栏状态正确显示当前路由。 | PRESENT_BEHAVIOR_UNVERIFIED | `sidebar-navigation.ts` 以最长前缀计算 active href；`sidebar.tsx` 在桌面和移动 Sheet 复用菜单与点击关闭回调；导航单测通过。浏览器视觉与交互仍需人工确认。 |
| 2 | observer_admin 只读访问两个独立页面，admin 和 super_admin 保留既有写入授权边界。 | VERIFIED | 两个页面均在读取依赖前使用 `canViewImageBackendPool` 守卫；供应商页面对 observer 传入 `readOnly`；三档角色和越权路径测试通过。 |
| 3 | 系统设置只保留系统设置与推广奖励，且仅 super_admin 可访问。 | VERIFIED | `settings/page.tsx` 在读取时区前校验 `canManageUserPermissions`；页签编排器仅装配两个保留页签；角色边界测试通过。 |
| 4 | 账号池对外显示为供应商管理，内部 image-backend-pool operation、数据库和调度命名不变。 | VERIFIED | 中英文导航与标题契约断言 `Supplier Management` / `供应商管理`；供应商面板标题与 mutation 刷新路径均指向 `/dashboard/admin/suppliers`，内部 feature 与 UOL 标识未改。 |
| 5 | 角色、路由、双语文案和构建质量均有自动验证。 | VERIFIED | 阶段聚焦 Vitest 27 项、Web typecheck、Web lint、生产构建和全量 Turbo 测试均通过。 |

**得分：** 4/5 个可观察事实已自动验证；第 1 项代码与逻辑均已连线，等待浏览器行为确认。

### 必需产物

| 产物 | 预期 | 状态 | 详情 |
|---|---|---|---|
| `admin/model-configuration/page.tsx` | 模型配置独立本地化页面 | EXISTS + SUBSTANTIVE | 服务端会话和角色守卫后装配 `ModelConfigurationPanel`。 |
| `admin/suppliers/page.tsx` | 供应商管理独立本地化页面 | EXISTS + SUBSTANTIVE | 服务端守卫后装配供应商面板，并向观察管理员传递只读状态。 |
| `admin/settings/page.tsx` 与 `admin-settings-tabs.tsx` | 高敏设置边界与两个保留页签 | EXISTS + SUBSTANTIVE | 仅 super_admin 能进入，页签仅包含系统设置和推广奖励。 |
| `features/dashboard/sidebar-navigation.ts` | 角色菜单和最长路径 active 纯函数 | EXISTS + SUBSTANTIVE | 包含角色菜单构建、locale 规范化和最长匹配逻辑。 |
| `features/dashboard/components/sidebar.tsx` | 桌面与移动端侧栏接入 | EXISTS + SUBSTANTIVE | 消费统一菜单和 active helper，移动入口点击后关闭 Sheet。 |
| `messages/en.json` 与 `messages/zh.json` | 独立导航和页面标题文案 | EXISTS + SUBSTANTIVE | 提供 `modelConfiguration`、`supplierManagement` 及只读提示键。 |
| 阶段页面、导航和 Action 测试 | 角色、路由和刷新回归测试 | EXISTS + SUBSTANTIVE | 6 个相关 Vitest 文件均为活跃测试，无 skip 或 todo 标记。 |

**产物：** 7/7 已验证。

### 关键连线验证

| 来源 | 目标 | 方式 | 状态 | 详情 |
|---|---|---|---|---|
| `DashboardSidebar` | 独立后台页面 | `buildAdministrationItems` 的 locale href | WIRED | 三种后台角色菜单包含 `/dashboard/admin/model-configuration`、`/dashboard/admin/suppliers`；只有 super_admin 额外获得 settings。 |
| `DashboardSidebar` | 统一 active 状态 | `findMostSpecificActiveHref` | WIRED | 父级支付菜单和所有叶子菜单使用同一 locale 规范化、最长路径规则。 |
| 独立页面 | 既有领域面板 | 页面服务端装配 | WIRED | 模型页面装配 `ModelConfigurationPanel`，供应商页面装配 `ImageBackendPoolAdminPanel`，没有复制领域逻辑。 |
| 供应商 mutation | 独立供应商页面 | `revalidatePath` | WIRED | 成功 mutation 统一刷新 `/dashboard/admin/suppliers`；Action 测试覆盖。 |
| 页面标题与侧栏 | 双语消息 | `getTranslations` 与导航 title map | WIRED | 页面和侧栏共同使用新增的 `Dashboard.pages`、`Dashboard.nav` 消息键。 |

**连线：** 5/5 已验证。

## 需求覆盖

| 需求 | 状态 | 阻塞问题 |
|---|---|---|
| NAV-01 | SATISFIED | - |
| NAV-02 | SATISFIED | - |
| NAV-03 | SATISFIED | - |
| NAV-04 | SATISFIED | 浏览器视觉和移动 Sheet 交互待人工验收，不阻断自动实现证据。 |
| AUTH-01 | SATISFIED | - |
| AUTH-02 | SATISFIED | - |
| AUTH-03 | SATISFIED | - |
| AUTH-04 | SATISFIED | - |
| PRES-01 | SATISFIED | - |
| PRES-02 | SATISFIED | - |
| PRES-03 | SATISFIED | - |
| VER-01 | SATISFIED | - |
| VER-02 | SATISFIED | - |
| VER-03 | SATISFIED | - |

**覆盖：** 14/14 个需求已满足。

## 反模式与测试质量审计

本阶段修改的实现文件未发现未关联 issue 的 TODO、FIXME、XXX、HACK、占位页面或空实现。模型搜索框的 `placeholder` 属性是正常输入提示，不是实现占位符。

| 测试文件 | 关联需求 | 活跃测试 | 跳过 | 断言强度 | 结论 |
|---|---|---:|---:|---|---|
| 三个 admin 页面测试 | AUTH-01 至 AUTH-04、NAV-01 至 NAV-03 | 15 | 0 | 行为 | 通过 |
| `sidebar-navigation.test.ts` | NAV-04 | 6 | 0 | 值与行为 | 通过 |
| `navigation-i18n-contract.test.ts` | PRES-01、PRES-02、VER-01 | 6 | 0 | 精确值 | 通过 |
| `image-backend-pool/actions.test.ts` | AUTH-02、PRES-03 | 9 | 0 | 调用与精确值 | 通过 |

未发现禁用测试、循环生成期望值或仅存在性断言。

## 自动检查

| 检查 | 结果 |
|---|---|
| 阶段聚焦 Vitest | 5 个文件、27 项测试通过。 |
| `pnpm --filter @repo/web typecheck` | 通过。 |
| `pnpm --filter @repo/web lint` | 通过，无 error；16 条既有 warning 与本阶段无关。 |
| `pnpm build` | 通过；存在既有 Turbopack NFT trace warning。 |
| `pnpm turbo test` | 327 个测试文件、2362 项测试通过。 |
| `01-SECURITY.md` | 7 个威胁均已关闭，`threats_open: 0`。 |

## 需要人工验证

### 1. 后台三角色的跨状态导航

**测试：** 分别使用 observer_admin、admin、super_admin 在中文和英文界面打开模型配置与供应商管理；检查桌面展开、桌面折叠和移动 Sheet。移动端点击两个入口后检查 Sheet 是否关闭。

**预期：** 当前入口始终显示 active 背景和左侧指示；observer_admin、admin 可见模型配置和供应商管理但无系统设置；super_admin 额外可见系统设置；移动端点击入口后 Sheet 关闭。

**为什么需要人工：** 单测已验证角色菜单、路径匹配和关闭回调，但无法验证运行时的 CSS 呈现与真实 Sheet 交互。

## 缺口摘要

没有实现缺口。阶段等待上述浏览器验收；未完成前不得标记 phase complete。

## 验证元数据

**验证方法：** 以阶段目标为起点，检查可观察事实、实现产物、关键连线、需求、测试质量和运行质量门。

**自动检查：** 6 项通过，0 项失败。

**人工检查：** 1 项。

**验证结论：** 自动实现证据完整，状态为 `human_needed`。
