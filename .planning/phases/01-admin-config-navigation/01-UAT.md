---
status: testing
phase: 01-admin-config-navigation
source: [01-VERIFICATION.md]
started: 2026-08-18T01:48:00+08:00
updated: 2026-08-18T01:48:00+08:00
---

## Current Test

number: 1
name: 后台三角色的供应商与分组导航跨状态浏览器验收
expected: |
  在已认证 Web 环境中，以 observer_admin、admin、super_admin 分别使用中文和英文界面，检查供应商管理与分组管理的桌面展开、桌面折叠及移动 Sheet。当前入口显示 active 背景和左侧指示；中文显示供应商管理/分组管理，英文显示 Supplier Management/Group Management；移动端点击入口后 Sheet 关闭；observer_admin 看不到系统设置和任何分组写控件。
awaiting: user response

## Tests

### 1. 后台三角色的供应商与分组导航跨状态浏览器验收
expected: 在已认证 Web 环境中，以 observer_admin、admin、super_admin 分别使用中文和英文界面，检查供应商管理与分组管理的桌面展开、桌面折叠及移动 Sheet；当前入口显示 active 背景和左侧指示，中文/英文菜单文案正确，移动端点击入口后 Sheet 关闭，observer_admin 看不到系统设置和分组写控件。
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps

None yet.
