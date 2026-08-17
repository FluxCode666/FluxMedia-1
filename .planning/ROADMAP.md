# Roadmap: FluxMedia 后台配置入口拆分

## Overview

本维护里程碑把现有系统设置页签中的模型配置与账号池入口拆分为独立的后台菜单页面。交付范围只覆盖页面装配、侧栏导航、权限边界、双语文案和聚焦验证；内部 `image-backend-pool` 领域、UOL operation、数据库与调度行为保持不变。

## Phases

**Phase Numbering:** sequential

- [ ] **Phase 1: 后台配置入口拆分** - 将模型配置与供应商管理交付为独立、安全、可测试的后台菜单页面

## Phase Details

### Phase 1: 后台配置入口拆分

**Goal**: 模型配置和供应商管理成为独立、安全、可测试的后台菜单页面，同时保留系统设置的高敏权限边界与现有内部领域命名。
**Depends on**: Nothing (first phase)
**Requirements**: NAV-01, NAV-02, NAV-03, NAV-04, AUTH-01, AUTH-02, AUTH-03, AUTH-04, PRES-01, PRES-02, PRES-03, VER-01, VER-02, VER-03
**Success Criteria** (what must be TRUE):

  1. 具备对应查看权限的后台角色可从展开、折叠和移动侧栏进入独立的模型配置或供应商管理页面，当前路由在所有侧栏状态下正确激活，并且中英文菜单文案一致。
  2. `observer_admin` 能只读查看两个独立页面，`admin` 与 `super_admin` 能访问两个页面，供应商管理写操作仍由现有 Action/UOL 权限校验决定。
  3. 系统设置页面只显示系统设置与推广奖励，只有 `super_admin` 可进入；未登录或无后台权限的请求在读取页面数据前由服务端重定向。
  4. 账号池入口和页面对外显示为“供应商管理”及 “Supplier Management”，运营人员仍可管理既有后端池配置，内部 `image-backend-pool` operation、数据库和调度领域名称不变。
  5. 导航多语言契约测试、角色与路由权限测试、聚焦测试、Web typecheck 和 Web lint 均通过。

**Plans**: 2/2 plans executed
Plans:

- [x] 01-01-PLAN.md — 独立模型配置与供应商管理页面、权限边界及系统设置页签收敛
- [x] 01-02-PLAN.md — 角色化侧栏激活、双语导航文案与契约验证

**UI hint**: yes

## Progress

**Execution Order:** Phase 1

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 后台配置入口拆分 | 2/2 | In Progress|  |

## Coverage

All 14 v1 requirements map exactly once to Phase 1. No orphaned or duplicated requirements.
