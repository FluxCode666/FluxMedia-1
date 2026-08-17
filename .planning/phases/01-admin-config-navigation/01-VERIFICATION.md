---
phase: 01-admin-config-navigation
verified: 2026-08-18T01:48:00+08:00
status: human_needed
score: 13/14 must-haves verified
behavior_unverified: 1
overrides_applied: 0
behavior_unverified_items:
  - truth: "具备权限的角色在展开、折叠和移动 Sheet 中打开供应商管理与分组管理时，active 样式、左侧指示和关闭交互均保持一致。"
    test: "使用 observer_admin、admin、super_admin 分别在 zh/en 打开模型配置、供应商管理和分组管理，切换桌面展开、桌面折叠及移动 Sheet，并点击入口。"
    expected: "三个入口均显示正确 active 背景和左侧指示；移动端点击入口后 Sheet 关闭；observer_admin 不显示系统设置且不能看到模型、供应商和分组写控件。"
    why_human: "helper、DOM 连线和点击回调已有测试，但真实 CSS 状态、桌面折叠布局和 Sheet 运行时行为需要浏览器观察。"
human_verification:
  - test: "在已认证 Web 环境中，以 observer_admin、admin、super_admin 分别使用中文和英文界面，检查模型配置、供应商管理和分组管理的展开侧栏、折叠侧栏及移动 Sheet。"
    expected: "三条入口各自在当前路由显示 active 背景和左侧指示；中文显示模型配置/供应商管理/分组管理，英文显示 Model Configuration/Supplier Management/Group Management；移动端点击入口后 Sheet 关闭；observer_admin 看不到系统设置和任何模型、供应商、分组写控件。"
    why_human: "自动化测试覆盖角色菜单、最长路径、翻译文本和移动点击回调，但无法证明真实浏览器中的 CSS active 状态、折叠 tooltip 和 Sheet 关闭后的视觉结果。"
---

# Phase 01: 后台配置入口拆分验证报告

**阶段目标：** 模型配置、供应商管理和分组管理成为独立、安全、可测试的后台菜单页面；供应商管理只承载供应商账号，同时保留系统设置的高敏权限边界与现有内部领域命名。

**验证时间：** 2026-08-18T01:48:00+08:00

**状态：** human_needed

**复核模式：** 初始验证。旧 `01-VERIFICATION.md` 没有 `gaps` 区块，因此未把其旧的 5 项事实清单当作本次范围；本次重新合并路线图 Success Criteria 与四份 PLAN 的 must-haves。

## 目标达成情况

### 可观察事实

| # | 事实 | 状态 | 证据 |
|---|---|---|---|
| 1 | 有查看权限的后台角色可从带 locale 的独立模型配置、供应商管理和分组管理入口到达页面，路由 active 判定使用统一最长前缀规则。 | PRESENT_BEHAVIOR_UNVERIFIED | `sidebar-navigation.ts:39-145,148-170` 构建角色菜单并去 locale 后选最长匹配；`sidebar.tsx:301-426` 在父项、子项和移动链接复用结果；`sidebar.test.ts:159-178` 真实渲染中文分组链接并验证移动关闭回调。真实桌面 CSS 与 Sheet 视觉状态仍需人工确认。 |
| 2 | `observer_admin` 可只读查看三个独立页面，`admin`/`super_admin` 可访问页面，写入继续由既有 Action/UOL 权限控制。 | VERIFIED | 三个页面分别在 `page.tsx` 通过 `canViewImageBackendPool` 后装配面板；供应商和分组按 `role === "observer_admin"` 传入 `readOnly`；10 个聚焦测试中的三份 page.test 覆盖三档角色矩阵；`actions.ts:307-393` 使用 `adminAction`，模型更新 binding 要求 super_admin。 |
| 3 | 系统设置只有 `super_admin` 可进入，且读取时区和装配页签前完成重定向；页签仅含系统设置和推广奖励。 | VERIFIED | `settings/page.tsx:22-38` 先会话、角色和 `canManageUserPermissions` 再读取时区；`admin-settings-tabs.tsx:29-103` 只有 `system`/`referrals` 两类并装配两个面板；设置 page.test 覆盖未登录、observer/admin/user 拒绝与 super_admin 放行。 |
| 4 | 供应商入口和页面外显为 Supplier Management/供应商管理，供应商页面只承载账号；旧 `poolTab=groups` 不恢复分组功能。 | VERIFIED | `admin-panel.tsx:424-581` 仅渲染账号统计、筛选、分页、成员卡片和成员表单，保留分组快照只作成员表单选项；`admin-pool-components.test.ts:123-144` 同时验证默认和 `poolTab=groups` URL 无分组列表/页签；消息契约测试精确断言中英文 nav/pages 标题。 |
| 5 | 分组筛选、分页、创建、编辑、删除和计费覆盖只经独立分组页面提供，分组 mutation 与供应商账号 mutation 成功后同时刷新两个入口。 | VERIFIED | `supplier-groups/page.tsx:23-54` 守卫后装配 `BackendGroupAdminPanel`；`backend-group-admin-panel.tsx:252-365` 提供筛选、分页、创建、编辑/删除及计费面板；`actions.ts:193-196,307-392` 成功 mutation 统一刷新 suppliers 和 supplier-groups，actions.test 覆盖成功、失败、读取不刷新。 |
| 6 | 内部 image-backend-pool operation、数据库/服务绑定和调度领域命名保持不变，页面层不复制领域逻辑。 | VERIFIED | 页面只调用现有面板；面板 Action 调用 `pool.getAdminPool`、`pool.listAdminMembers`、`pool.listAdminGroups` 等 UOL 名称；`apps/web/src/server/uol-bindings/image-backend-pool.ts:375-421` 绑定真实 group/member service；model binding `:298-314` 绑定真实配置服务。 |
| 7 | 独立页面的会话/角色守卫先于分页、时区、翻译和客户端面板装配。 | VERIFIED | model/suppliers/group 页面均在 `page.tsx` 先 `getServerSession`、`getUserRoleById`、能力检查，再读取分页/时区/翻译并返回面板；三份 page.test 明确断言越权时依赖和面板均未调用。 |
| 8 | 模型只读能力由 UOL 的 `canEdit=false` 驱动，供应商/分组只读状态隐藏写控件。 | VERIFIED | `model-configuration-panel.tsx:248-275,345-395` 依据 `pageResult.canEdit` 隐藏新增并传给表格/Dialog；`admin-panel.tsx:452-490,531-536`、`backend-group-admin-panel.tsx:279-325` 依据 `readOnly` 隐藏写入口；UOL binding 对模型读取返回按 Principal 计算的 DTO；面板契约测试验证供应商只读和分组只读行为。 |
| 9 | 中英文 nav/pages 键、title map 与真实侧栏渲染一致，内部标题不会泄漏为中文界面的英文入口。 | VERIFIED | `messages/en.json`/`zh.json` 提供 modelConfiguration、supplierManagement、groupManagement；`sidebar.tsx:154-186` 有三个精确映射；`navigation-i18n-contract.test.ts:16-67` 与 `sidebar.test.ts:160-173` 分别锁定消息和中文 DOM 文本。 |
| 10 | 三档后台菜单含独立分组入口，普通 user 无管理入口，只有 super_admin 看到系统设置。 | VERIFIED | `sidebar-navigation.ts:39-145` 明确区分 observer/admin/super_admin；`sidebar-navigation.test.ts:15-63` 覆盖四角色 href 顺序；i18n 契约测试断言 observer/admin 无 settings、super_admin 有 settings。 |
| 11 | 分组页面服务端只读/写权限和页面读取顺序独立于供应商页面，且 observer 不能写分组。 | VERIFIED | `supplier-groups/page.tsx:28-53` 在读取分页和装配面板前守卫；`readOnly` 传递到 `BackendGroupList` 与表单入口；page.test 和 backend-group-admin-panel.test 覆盖三档角色与只读控件。 |
| 12 | 阶段聚焦测试、Web typecheck 和 Web lint 质量门有明确可重复证据。 | VERIFIED | 本次独立执行 10 个阶段测试文件，报告 `10 passed / 53 passed`；`pnpm --filter @repo/web typecheck` 退出 0；`pnpm --filter @repo/web lint` 退出 0，只有 16 条既有 warning。 |
| 13 | 供应商/分组页面的加载骨架存在并通过 `aria-busy` 传达服务端加载状态。 | VERIFIED | 三个 loading.tsx 均为实质性骨架，根节点 `aria-busy="true"`、`role="status"`，并包含对应标题、统计/筛选/列表层级。 |
| 14 | 面板渲染值均来自真实 UOL/服务层数据，而非静态空返回。 | VERIFIED | model panel `listModelConfigurationsAction` 调 `settings.listModelConfigurations`，其 Web binding 调 `readModelConfigurationPage`；supplier/group actions 分别调 pool UOL，Web binding 查询 group/member service 并分页；组件将 action `data` 写入 `pageResult/memberPage/groupPage` 后渲染。 |

**得分：** 13/14 个合并 must-haves 已验证；1 项为代码与连线存在但浏览器运行时交互尚未实测。

## 必需产物

| 产物 | 预期 | 状态 | 详情 |
|---|---|---|---|
| `admin/model-configuration/page.tsx`、`loading.tsx`、`page.test.ts` | 独立模型配置页面、骨架和角色矩阵 | VERIFIED | 页面先守卫后读取分页并装配既有面板；测试覆盖未登录、user、observer/admin/super_admin。 |
| `admin/suppliers/page.tsx`、`loading.tsx`、`page.test.ts` | 独立供应商管理页面、骨架和角色矩阵 | VERIFIED | 页面先守卫后并行读取分页/时区，observer 传只读；测试覆盖读取顺序。 |
| `admin/supplier-groups/page.tsx`、`loading.tsx`、`page.test.ts` | 独立分组管理页面、骨架和角色矩阵 | VERIFIED | 页面先守卫后读取分页/翻译并传只读；测试覆盖角色边界。 |
| `admin/settings/page.tsx`、`admin-settings-tabs.tsx`、`page.test.ts` | 超管高敏设置与两页签装配 | VERIFIED | 只保留 system/referrals，越权先重定向。 |
| `sidebar-navigation.ts`、`sidebar.tsx`、导航测试 | 角色菜单、locale active、桌面/移动消费 | VERIFIED | 纯函数与真实 DOM 测试均存在且被 Vitest 收集。 |
| `admin-panel.tsx`、`backend-group-admin-panel.tsx` 与组件测试 | 账号/分组职责拆分和只读控件 | VERIFIED | 供应商不再渲染分组管理，分组面板承接原有能力。 |
| `actions.ts` 与 `actions.test.ts` | UOL 薄适配和双路由刷新 | VERIFIED | 统一 pool operation 调用与成功/失败刷新契约已通过。 |
| `messages/en.json`、`messages/zh.json` | nav/pages 双语键 | VERIFIED | 中英文精确值由契约测试锁定。 |

## 关键连线验证

| 来源 | 目标 | 方式 | 状态 | 详情 |
|---|---|---|---|---|
| 三个独立页面 | 会话/角色守卫 | `getServerSession` → `getUserRoleById` → `canViewImageBackendPool`/`canManageUserPermissions` | WIRED | 守卫发生在分页、时区、翻译和面板 JSX 之前。 |
| `DashboardSidebar` | 三条管理路由 | `buildAdministrationItems` → `localizedHref` | WIRED | observer/admin/super_admin 角色与 locale href 测试通过。 |
| 侧栏父/子项 | active 样式 | `normalizeSidebarPath` → `findMostSpecificActiveHref` | WIRED | 深层 payment 与 supplier-groups 路径最长匹配测试通过；真实 CSS 见人工项。 |
| `ModelConfigurationPanel` | model UOL | `listModelConfigurationsAction` → `invokeOperation("settings.listModelConfigurations")` | WIRED | binding 连接真实模型配置服务并返回分页 DTO。 |
| `ImageBackendPoolAdminPanel` | pool UOL | `getAdminImageBackendPoolAction`/member action → `pool.*` | WIRED | Web binding 查询真实 group/member service；成员数据流到列表。 |
| `BackendGroupAdminPanel` | group UOL | group list/save/delete actions → `pool.listAdminGroups`/`pool.saveGroup`/`pool.deleteGroup` | WIRED | 不直连数据库；成功 mutation 触发双路由刷新。 |
| pool mutation | 两个管理页面 | `revalidateBackendPoolPage` → `/dashboard/admin/suppliers` + `/dashboard/admin/supplier-groups` | WIRED | actions.test 精确断言双路径，失败和纯读取不刷新。 |

## 数据流追踪（Level 4）

| 产物 | 数据变量 | 来源 | 产生真实数据 | 状态 |
|---|---|---|---|---|
| `ModelConfigurationPanel` | `pageResult` | `listModelConfigurationsAction` → `settings.listModelConfigurations` → model marketplace binding/service | 是 | FLOWING |
| `ImageBackendPoolAdminPanel` | `groups`, `members`, `memberPage` | `pool.getAdminPool`/`pool.listAdminMembers` → group/member service | 是 | FLOWING |
| `BackendGroupAdminPanel` | `groups`, `members`, `groupPage`, pricing models | `pool.getAdminPool`/`pool.listAdminGroups`/`settings.getModelConfiguration` → service bindings | 是 | FLOWING |
| `DashboardSidebar` | role/menu labels/active href | session role、`Dashboard.nav` translations、pathname helper | 是（非 DB UI 配置） | FLOWING |

## 行为 Spot-check

| 行为 | 命令 | 结果 | 状态 |
|---|---|---|---|
| 页面守卫、角色矩阵、供应商/分组职责、双路由刷新、侧栏 DOM | `pnpm --filter @repo/web exec vitest run`（10 个指定测试文件） | 10 个文件、53 项通过，2.15s | PASS |
| TypeScript 严格类型 | `pnpm --filter @repo/web typecheck` | 退出码 0 | PASS |
| Web lint | `pnpm --filter @repo/web lint` | 退出码 0；16 条既有 warning，无 error | PASS |

## Probe 执行

本阶段计划、SUMMARY 和路线图未声明 `scripts/*/tests/probe-*.sh` 探针；无需执行，状态为 SKIPPED（非迁移/CLI 阶段）。

## 需求覆盖

| 需求 | 来源计划 | 状态 | 证据 |
|---|---|---|---|
| NAV-01 | 01-01/01-02 | SATISFIED | 独立模型路由、角色菜单及 page.test。 |
| NAV-02 | 01-01/01-02 | SATISFIED | 独立 suppliers 路由、菜单及标题契约。 |
| NAV-03 | 01-01 | SATISFIED | settings tabs 仅 system/referrals，page.test。 |
| NAV-04 | 01-02 | SATISFIED | 最长匹配 helper、locale 测试和侧栏 DOM 连线；视觉部分列入人工项。 |
| NAV-05 | 01-03/01-04 | SATISFIED | supplier-groups 路由、角色菜单和供应商账号专用面板。 |
| NAV-06 | 01-04 | SATISFIED | 默认与 `poolTab=groups` URL 组件测试均无分组入口。 |
| AUTH-01 | 01-01 | SATISFIED | suppliers/model 页面三档查看角色和 observer 只读。 |
| AUTH-02 | 01-01 | SATISFIED | adminAction/UOL 写入边界未改变，动作契约通过。 |
| AUTH-03 | 01-01 | SATISFIED | settings 仅 super_admin 通过，其他角色先重定向。 |
| AUTH-04 | 01-01/01-02 | SATISFIED | 未登录和无权限在依赖读取前重定向。 |
| AUTH-05 | 01-03 | SATISFIED | 分组页面 observer 只读，管理员写入经既有 Action/UOL。 |
| AUTH-06 | 01-03 | SATISFIED | 分组 page.test 证明分页/翻译/面板装配前守卫。 |
| PRES-01 | 01-01/01-02/01-04 | SATISFIED | nav/pages 精确为 Supplier Management/供应商管理。 |
| PRES-02 | 01-02 | SATISFIED | nav/pages modelConfiguration 与 supplierManagement 双语契约。 |
| PRES-03 | 01-01至01-04 | SATISFIED | pool operation、binding、feature 目录和服务命名保留。 |
| PRES-04 | 01-03/01-04 | SATISFIED | groupManagement 双语键、独立面板及供应商旧入口测试。 |
| VER-01 | 01-02/01-04 | SATISFIED | navigation-i18n-contract.test.ts 精确断言。 |
| VER-02 | 01-01/01-03 | SATISFIED | 三独立页面测试覆盖未登录、user、observer/admin/super_admin。 |
| VER-03 | 01-01至01-04 | SATISFIED | 本次 53 项聚焦测试、typecheck、lint 均通过。 |
| VER-04 | 01-03/01-04 | SATISFIED | 双刷新、职责拆分、旧查询、双语菜单和分组角色测试通过。 |

REQUIREMENTS.md 未发现映射到本阶段但没有任何计划声明的孤立 requirement；20 个路线图 requirement 均有计划来源和实现证据。

## 反模式扫描

| 文件 | 结果 | 严重性 | 影响 |
|---|---|---|---|
| 阶段修改的页面、面板、Action、消息和测试文件 | 未发现未关联 issue 的 TBD/FIXME/XXX/TODO/HACK、占位实现或空业务返回 | 无 | 不构成阻塞。消息 JSON 中的 `placeholder` 是正常输入提示属性。 |
| Web lint | 16 条 warning，均来自既有脚本、旧页面或旧测试 | 信息 | lint 仍退出 0，未发现阶段新增阻塞错误。 |

## 对 01-REVIEW.md 的独立判断

- CR-01（英文页面主体仍有中文）不是本阶段锁定需求的阻塞项。`REQUIREMENTS.md` 的 PRES-01/PRES-02/PRES-04 只要求供应商、分组、模型的菜单和页面主标题双语，以及导航消息契约；路线图成功标准也要求“中英文菜单文案一致”，没有声明完整面板操作文案国际化。现有代码确实保留了面板主体中文，这是后续国际化改造建议，但不否定本阶段独立入口、标题和权限目标。
- WR-01（异步响应乱序）不是本阶段锁定需求的阻塞项。该问题涉及筛选/分页请求的取消和排序不变量，而 NAV/AUTH/PRES/VER requirement 未要求请求竞态处理；模型和供应商相关请求逻辑主要由更早提交引入，分组面板则是本阶段新增但其计划成功标准也未包含乱序响应。应作为后续健壮性工作跟踪，不改变本阶段验证状态。

## 人工验证

### 1. 三档角色跨状态导航

**测试：** 在已认证环境中，以 observer_admin、admin、super_admin 分别使用 zh/en，打开模型配置、供应商管理和分组管理，切换桌面展开、桌面折叠和移动 Sheet；点击三个入口，并检查 observer_admin 的可见菜单和写控件。

**预期：** active 背景和左侧指示始终跟随当前路由；中文显示“模型配置/供应商管理/分组管理”，英文显示 “Model Configuration/Supplier Management/Group Management”；移动端入口点击后 Sheet 关闭；observer_admin 不显示系统设置且不出现模型、供应商或分组写控件。

**为什么需要人工：** 代码和 jsdom 已证明菜单、href、最长匹配、翻译和关闭回调存在，但真实浏览器 CSS、折叠 tooltip 和 Sheet 状态不能由静态检查完全推断。

## 缺口摘要

没有发现实现缺口或 blocker。阶段当前为 `human_needed`，原因仅是上述浏览器跨状态导航验收尚未完成；在人工项确认前不应把阶段标记为 complete。

---

_Verified: 2026-08-18T01:48:00+08:00_
_Verifier: the agent (gsd-verifier)_
