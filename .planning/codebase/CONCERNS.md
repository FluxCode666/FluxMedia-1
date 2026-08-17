# 当前风险与关注点

**分析日期：** 2026-08-17

## 高优先级边界

### UOL 迁移仍有未接线 operation

`apps/web/src/server/uol-bindings.ts` 保留多条 TODO，表明部分历史能力尚未通过统一 operation registry 暴露。新增或改造功能不能复制旧直连模式，应继续采用 UOL 并将未接线项作为独立、可验证的迁移工作处理。

### 财务与生成流程不可随意重构

积分账务以 `credits_transaction` 为事实源，图像生成以单一管线为准。涉及扣费、退款、队列恢复或供应商重试时必须维护幂等键、数据库约束与事务边界。

## 中优先级维护点

### 管理端路由与菜单权限需保持一致

管理导航定义在 `apps/web/src/features/dashboard/components/sidebar.tsx`，但最终授权必须由各路由、Action 和 UOL 再次验证。重构设置 tab 为独立页面时，特别要覆盖 observer_admin、admin 与 super_admin 的可见性和访问边界。

### 后端池领域命名与产品文案不同

代码中仍大量使用 `image-backend-pool` 和“账号池”作为内部领域术语；产品菜单可能改称“供应商管理”。UI 文案可以更新，但 operation 名、持久化模型和服务文件名不应为纯展示目的大范围改名。

### 大型 feature 模块需要克制改动

`apps/web/src/features/image-backend-pool/`、`apps/web/src/features/image-generation/` 和模型配置模块拥有大量契约测试。优先在页面装配、导航和文案边界完成改动，避免在无需求时触碰调度或账务核心。

## 验证风险

- 全仓测试覆盖广且可能耗时；先运行聚焦 Vitest、Web typecheck 和 Web lint，再按改动风险决定是否运行 Turbo 全量质量门。
- 路由组路径含括号和方括号，shell 命令必须正确引用路径，避免错误地读写相邻文件。
- 生成的规划文档在提交前应扫描常见密钥模式，不记录环境文件内容或供应商凭据。

## 后续建议

- 使用 `docs/plan/` 的现有架构与实施计划作为业务事实来源。
- 将每次 UI 导航调整限制为显式路由、权限、菜单、文案和契约测试的闭环。
- 当新增可运营配置或外部传输面时，先更新 UOL inventory 和对应测试，再实现 UI。

---
*最后分析：2026-08-17*
