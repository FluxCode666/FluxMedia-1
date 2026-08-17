# Requirements: FluxMedia 后台配置入口拆分

**Defined:** 2026-08-17
**Core Value:** 用户和运营人员能够通过清晰、安全、稳定的入口使用并管理真实可用的媒体生成能力。

## v1 Requirements

### Navigation

- [ ] **NAV-01**: 有模型配置查看权限的后台角色可从独立菜单进入模型配置页面
- [ ] **NAV-02**: 有后端池查看权限的后台角色可从独立菜单进入供应商管理页面
- [ ] **NAV-03**: 系统设置页面不再挂载模型配置和后端池页签，只保留系统设置与推广奖励
- [ ] **NAV-04**: 当前模型配置或供应商管理路由在展开、折叠和移动侧栏中均能正确激活

### Authorization

- [ ] **AUTH-01**: observer_admin 可只读访问模型配置与供应商管理页面
- [ ] **AUTH-02**: admin 和 super_admin 可访问两个独立页面，供应商管理写能力继续由现有 Action/UOL 控制
- [ ] **AUTH-03**: 只有 super_admin 能进入保留高敏设置的系统设置页面
- [ ] **AUTH-04**: 未登录和无后台权限的用户在读取页面数据前被服务端重定向

### Presentation

- [ ] **PRES-01**: 账号池的菜单和页面主标题改为“供应商管理”，英文显示为“Supplier Management”
- [ ] **PRES-02**: 中英文导航消息均提供模型配置与供应商管理的独立文案
- [ ] **PRES-03**: 内部 `image-backend-pool` operation、数据库和调度领域名称保持不变

### Verification

- [ ] **VER-01**: 导航多语言契约测试锁定两个独立菜单文案
- [ ] **VER-02**: 路由权限测试覆盖 observer_admin、admin、super_admin 和无权限用户的关键边界
- [ ] **VER-03**: 聚焦测试、Web typecheck 与 Web lint 全部通过

## v2 Requirements

本里程碑没有延期功能；后续若要统一重命名内部后端池领域，应作为独立架构迁移重新规划。

## Out of Scope

| Feature | Reason |
|---------|--------|
| 重命名数据库表、UOL operation 或 feature 目录 | 产品展示改名不需要承担跨层迁移风险 |
| 修改供应商调度与模型匹配 | 与菜单拆分无关 |
| 修改模型价格、积分或支付规则 | 本次不触碰财务事实与定价 |
| 引入新的导航或 UI 依赖 | 现有 sidebar 和 `@repo/ui` 足以完成 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| NAV-01 | Phase 1 | Pending |
| NAV-02 | Phase 1 | Pending |
| NAV-03 | Phase 1 | Pending |
| NAV-04 | Phase 1 | Pending |
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 1 | Pending |
| AUTH-04 | Phase 1 | Pending |
| PRES-01 | Phase 1 | Pending |
| PRES-02 | Phase 1 | Pending |
| PRES-03 | Phase 1 | Pending |
| VER-01 | Phase 1 | Pending |
| VER-02 | Phase 1 | Pending |
| VER-03 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-08-17*
*Last updated: 2026-08-17 after initial definition*
