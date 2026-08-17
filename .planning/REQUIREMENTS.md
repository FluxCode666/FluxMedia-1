# Requirements: FluxMedia 后台配置入口拆分

**Defined:** 2026-08-17
**Core Value:** 用户和运营人员能够通过清晰、安全、稳定的入口使用并管理真实可用的媒体生成能力。

## v1 Requirements

### Navigation

- [x] **NAV-01**: 有模型配置查看权限的后台角色可从独立菜单进入模型配置页面
- [x] **NAV-02**: 有后端池查看权限的后台角色可从独立菜单进入供应商管理页面
- [x] **NAV-03**: 系统设置页面不再挂载模型配置和后端池页签，只保留系统设置与推广奖励
- [x] **NAV-04**: 当前模型配置或供应商管理路由在展开、折叠和移动侧栏中均能正确激活
- [ ] **NAV-05**: 有后端池查看权限的后台角色可从独立菜单进入分组管理页面，供应商管理页面只承载供应商账号管理
- [ ] **NAV-06**: 旧供应商页面的 `poolTab=groups` 查询参数不再作为分组功能入口，分组功能只通过独立分组管理路由提供

### Authorization

- [x] **AUTH-01**: observer_admin 可只读访问模型配置与供应商管理页面
- [x] **AUTH-02**: admin 和 super_admin 可访问两个独立页面，供应商管理写能力继续由现有 Action/UOL 控制
- [x] **AUTH-03**: 只有 super_admin 能进入保留高敏设置的系统设置页面
- [x] **AUTH-04**: 未登录和无后台权限的用户在读取页面数据前被服务端重定向
- [ ] **AUTH-05**: observer_admin 可只读访问分组管理，admin 和 super_admin 继续仅通过既有 Action/UOL 执行分组创建、编辑、删除和计费覆盖写入
- [ ] **AUTH-06**: 未登录和无后台权限的用户在分组管理页面读取分页、时区或装配面板前被服务端重定向

### Presentation

- [x] **PRES-01**: 账号池的菜单和页面主标题改为“供应商管理”，英文显示为“Supplier Management”
- [x] **PRES-02**: 中英文导航消息均提供模型配置与供应商管理的独立文案
- [x] **PRES-03**: 内部 `image-backend-pool` operation、数据库和调度领域名称保持不变
- [ ] **PRES-04**: 分组菜单和页面主标题在中文显示“分组管理”，英文显示“Group Management”，且供应商管理不再展示分组页签

### Verification

- [x] **VER-01**: 导航多语言契约测试锁定两个独立菜单文案
- [x] **VER-02**: 路由权限测试覆盖 observer_admin、admin、super_admin 和无权限用户的关键边界
- [x] **VER-03**: 聚焦测试、Web typecheck 与 Web lint 全部通过
- [ ] **VER-04**: 聚焦测试锁定分组页面角色边界、账号与分组面板职责拆分、旧查询参数失效、双语菜单以及分组或账号 mutation 同时刷新两个相互影响的页面

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
| NAV-01 | Phase 1 | Complete |
| NAV-02 | Phase 1 | Complete |
| NAV-03 | Phase 1 | Complete |
| NAV-04 | Phase 1 | Complete |
| AUTH-01 | Phase 1 | Complete |
| AUTH-02 | Phase 1 | Complete |
| AUTH-03 | Phase 1 | Complete |
| AUTH-04 | Phase 1 | Complete |
| PRES-01 | Phase 1 | Complete |
| PRES-02 | Phase 1 | Complete |
| PRES-03 | Phase 1 | Complete |
| VER-01 | Phase 1 | Complete |
| VER-02 | Phase 1 | Complete |
| VER-03 | Phase 1 | Complete |
| NAV-05 | Phase 1 | Planned |
| NAV-06 | Phase 1 | Planned |
| AUTH-05 | Phase 1 | Planned |
| AUTH-06 | Phase 1 | Planned |
| PRES-04 | Phase 1 | Planned |
| VER-04 | Phase 1 | Planned |

**Coverage:**

- v1 requirements: 20 total
- Mapped to phases: 20
- Unmapped: 0

---
*Requirements defined: 2026-08-17*
*Last updated: 2026-08-18 after Phase 01 scope increment*
