---
phase: 1
slug: admin-config-navigation
status: draft
shadcn_initialized: true
preset: new-york (neutral, cssVariables)
created: 2026-08-17
---

# Phase 1 — UI Design Contract

> 模型配置与供应商管理从系统设置页签拆分为独立后台入口；只约束页面装配、导航、文案和状态，不改变 image-backend-pool 领域、数据模型或操作接口。

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn |
| Preset | `new-york`, `neutral`, CSS variables（来源：`apps/web/components.json`） |
| Component library | Radix primitives via `@repo/ui` shadcn components |
| Icon library | Lucide（来源：现有 `sidebar.tsx` 与面板） |
| Font | `var(--font-geist-sans)`（界面正文）；`var(--font-geist-mono)` 仅模型 ID/技术值 |
| Existing patterns | `Card`/`Tabs`/`Button`/`Input`/`Select`、sonner toast、URL 分页、服务端页面守卫 |

## Spacing Scale

Declared values (must be multiples of 4):

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | 图标与文字间隙、徽章内边距 |
| sm | 8px | 工具栏控件、列表行内间距 |
| md | 16px | 卡片内容与默认控件间距 |
| lg | 24px | 页面区块和卡片组间距 |
| xl | 32px | 页面主内容边距、统计卡网格间距 |
| 2xl | 48px | 页面标题与首个内容区之间的分隔 |
| 3xl | 64px | 仅用于宽屏页面上下留白，不用于列表内部 |

Exceptions: 侧栏与菜单项维持现有高度；所有可点击图标按钮最小 44px 触摸区域（视觉图标可为 16px）。

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 16px | 400 | 1.5 |
| Label | 14px | 400 | 1.4 |
| Heading | 20px | 600 | 1.2 |
| Display | 28px | 600 | 1.2 |

页面标题使用 Heading；统计数字或模型数量使用 Display；侧栏标签沿用现有 `text-sm font-medium`，不要引入额外字体级别。

## Color

使用 `packages/ui/src/globals.css` 的语义 CSS 变量，禁止在业务页面写新色值。

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `hsl(var(--background))` / `bg-background` | 页面背景、主内容表面 |
| Secondary (30%) | `hsl(var(--card))`、`bg-sidebar`、`bg-muted/30` | 卡片、侧栏、表格分组和骨架 |
| Accent (10%) | `hsl(var(--sidebar-accent))`、`hsl(var(--primary))` | 当前侧栏菜单、主 CTA、保存/新增按钮、焦点环；不用于普通静态文本 |
| Destructive | `hsl(var(--destructive))` | 删除供应商、禁用/重置等破坏性操作及错误提示 |

Accent reserved for: 当前路由背景与左侧激活线、`新增模型`/`新增供应商`/`保存`主按钮、键盘 focus-visible ring。只读徽章使用 muted，不使用 accent。

## Copywriting Contract

| Element | zh-CN | en-US |
|---------|-------|--------|
| Model menu/title | 模型配置 | Model Configuration |
| Supplier menu/title | 供应商管理 | Supplier Management |
| System settings menu/title | 系统设置 | System Settings |
| Primary CTA (model) | 新增模型 | Add Model |
| Primary CTA (supplier) | 新增供应商 | Add Supplier |
| Save CTA | 保存配置 | Save Configuration |
| Empty model heading | 暂无模型配置 | No model configurations |
| Empty model body | 尚未配置可用模型，请点击“新增模型”开始。 | No models are configured. Select “Add Model” to get started. |
| Empty supplier heading | 暂无供应商 | No suppliers |
| Empty supplier body | 尚未配置供应商账号或分组，请点击“新增供应商”开始。 | No supplier accounts or groups are configured. Select “Add Supplier” to get started. |
| Error state | 配置暂时无法加载，请稍后重试。 | Configuration could not be loaded. Try again later. |
| Read-only notice | 当前角色仅可查看，写操作已禁用。 | Your role is read-only; editing is disabled. |
| Destructive confirmation | 删除供应商“{name}”？此操作不可撤销。 | Delete supplier “{name}”? This action cannot be undone. |

Destructive actions: 删除供应商/账号、禁用账号、重置运行状态沿用现有 Dialog/AlertDialog 二次确认；只读角色不渲染可提交或删除按钮。不要把内部 `image-backend-pool` 作为用户可见标题。

## Page and Interaction Contract

- 独立路由：`/[locale]/dashboard/admin/model-configuration` 与 `/[locale]/dashboard/admin/suppliers`；系统设置保留 `.../dashboard/admin/settings`，仅显示系统设置、推广奖励两个页签。
- 页面均复用现有 dashboard 内容容器、`Card`、面板和 URL 分页/筛选模式；模型配置页直接装配 `ModelConfigurationPanel`，供应商管理页直接装配 `ImageBackendPoolAdminPanel`（内部 operation 名称不改）。页面标题与首个内容卡片是主视觉焦点，标题到首个卡片使用 `2xl` 间距，统计卡或列表卡随后按 `lg` 间距分组，避免空白背景成为视觉锚点。
- 侧栏 Administration 分组同时提供三项：模型配置、供应商管理、系统设置。路由匹配采用最长前缀，展开、折叠、移动 Sheet 三种状态均显示同一 active 背景和左侧 2px 指示线；折叠态用 tooltip/title 展示完整双语标签，移动端点击后关闭 Sheet。
- `observer_admin` 可进入两个独立页面但所有写控件 disabled/隐藏并显示只读 notice；`admin` 可访问模型与供应商页面，供应商写权限仍由既有 Action/UOL 决定；`super_admin` 另可进入系统设置。
- 未登录或无后台权限在任何数据 Action 之前由服务端页面/layout 重定向；页面不闪现敏感内容。
- 中英文消息键必须分别提供 `modelConfiguration` 与 `supplierManagement`，测试锁定精确文案“模型配置 / 供应商管理”和“Model Configuration / Supplier Management”。

## UI Considerations

Applicable state considerations resolved: 8 covered, 1 backstop, 0 unresolved

| Category | Element(s) | Status | Resolution / Reason |
|----------|------------|--------|---------------------|
| loading | 两个独立页面主列表 | ✅ covered | 首次读取显示与现有面板一致的 Card/列表骨架，`aria-busy=true`，不显示空态或写按钮。 |
| empty | 模型列表、供应商账号/分组列表 | ✅ covered | 分别使用 Copywriting Contract 的空态标题/正文，并保留对应新增 CTA（只读时隐藏 CTA）。 |
| error | 页面数据读取、保存失败 | ✅ covered | 显示错误文案与“重试/Retry”按钮；保存失败使用 toast，不清空已加载快照。 |
| populated | 表格、账号卡片、分组卡片 | ✅ covered | 沿用现有分页、筛选、统计卡和 Dialog；长模型 ID 使用 `font-mono` 截断并提供 Tooltip。 |
| permission/read-only | observer_admin、普通 user、未登录 | ✅ covered | 服务端先重定向；observer 只读面板明确 notice，按钮 disabled/不挂载，Action/UOL 继续做最终授权。 |
| overflow | 侧栏标签、模型/供应商长名称 | ✅ covered | 桌面折叠侧栏只保留图标并提供 title/tooltip；内容列 `min-w-0`、truncate，详情在 Tooltip/Dialog 查看。 |
| collapsed sidebar | 当前两个独立路由 | ✅ covered | 折叠时 active 路由仍有背景、左竖线和 pending 指示；点击一级项先展开侧栏再进入。 |
| mobile | 侧栏 Sheet、页面工具栏与表格 | 🧪 backstop | 移动 Sheet 始终展开标签并点击关闭；页面区块单列堆叠，表格允许横向滚动；通过聚焦测试验证无横向页面溢出。 |
| long-text | 错误、供应商名称、模型 ID | ✅ covered | 错误正文可换行；名称/ID 单行省略，Tooltip 或 Dialog 提供完整值，不能撑破卡片。 |

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | 现有 `Card`, `Tabs`, `Button`, `Input`, `Select`, `Dialog`, `Sheet`, `Tooltip`, `Skeleton` | not required（项目已初始化；本阶段不引入新 registry） |
| Third-party | none | not applicable |

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS（已补充主视觉焦点）
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved
