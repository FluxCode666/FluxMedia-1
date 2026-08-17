---
phase: 01
slug: admin-config-navigation
status: verified
threats_open: 0
asvs_level: 1
created: 2026-08-17
---

# Phase 01 — Security

> 本阶段安全契约：管理员页面入口、面板只读边界、导航路径和双语消息保持可验证。

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| 浏览器 → 本地化 admin 页面 | 未登录、普通用户和伪造客户端路由请求进入服务端页面守卫。 | session、locale、pathname |
| 页面面板 → Server Action/UOL | 客户端筛选、按钮和只读状态均是不可信输入，Action/UOL 必须重新校验 Principal。 | 分页参数、管理 mutation、Principal |
| 管理员 → 系统设置写入 | 系统设置包含高敏配置，页面可见性不能替代服务端权限。 | 系统配置、管理员身份 |
| 会话角色 → 侧栏菜单 | 侧栏只提供发现性入口，不能被当作授权边界。 | role、菜单项 |
| locale/pathname → active helper | URL 路径是不可信字符串，必须规范化并避免父路由误匹配。 | locale、pathname |
| 消息 JSON → 页面渲染 | 双语消息是构建时输入，键缺失或外显内部名会造成信息误导。 | nav/pages 消息 |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Elevation of Privilege | model-configuration/page.tsx、suppliers/page.tsx | high | mitigate | 页面在读取分页、时区和面板数据前完成实时角色守卫；查看能力由既有能力函数判定，写入继续由 Action/UOL 校验；路由边界测试覆盖。 | closed |
| T-01-02 | Information Disclosure | observer_admin 供应商面板 | high | mitigate | 服务端计算 `readOnly`，面板隐藏新增、编辑、删除、启停和重置控件；只读组件测试锁定行为。 | closed |
| T-01-03 | Tampering | admin-settings-tabs.tsx 与 settings/page.tsx | high | mitigate | 系统设置页面只接受 super_admin，移除模型配置和供应商页签旁路装配；页面测试覆盖角色边界。 | closed |
| T-01-04 | Repudiation | image-backend-pool/actions.ts mutation 刷新 | medium | mitigate | 保留既有 operation metadata、Principal 和审计装饰，仅把重新校验目标切换至 suppliers；Action 测试锁定刷新路径。 | closed |
| T-01-05 | Elevation of Privilege | sidebar role menu | medium | mitigate | 角色化菜单只影响发现性；独立页面继续执行服务端守卫，导航测试覆盖 user、observer_admin、admin、super_admin。 | closed |
| T-01-06 | Tampering | active pathname matching | medium | mitigate | 纯 helper 去 locale 前缀并按最长 href 匹配，展开、折叠和移动侧栏共享同一 active 计算；路径测试覆盖深层路由。 | closed |
| T-01-07 | Information Disclosure | Dashboard.nav/pages messages | low | mitigate | 中英文消息契约测试锁定模型配置与供应商管理文案，并阻止外显 image-backend-pool 内部名称。 | closed |

## Accepted Risks Log

No accepted risks.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-17 | 7 | 7 | 0 | GSD secure-phase L1 verification |

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-17
