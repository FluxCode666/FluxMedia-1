# 代码约定

**分析日期：** 2026-08-17

## TypeScript 与格式

- TypeScript 处于 strict 模式，禁止显式 `any`；外部未知数据使用 `unknown` 加收窄。
- Biome 统一双引号、分号、2 空格缩进和 80 列行宽，配置见 `biome.json`。
- 每个生产文件以职责、使用方和关键依赖的文件注释开头。
- 函数和组件的注释说明用途、参数、返回、副作用与失败边界；复杂逻辑解释原因。

## React 与页面

- 首选 Server Component；只有事件、状态或浏览器 API 需要时才添加 `"use client"`。
- 页面将会话、角色和 URL 参数限制在路由层，业务读取和写入通过 feature Action/UOL。
- 使用 `@repo/ui/components/*`；不在 feature 中复制 Button、Tabs、Dialog 等基础组件。
- 本地化导航从 `apps/web/src/i18n/routing.ts` 导入，以保证 locale 前缀和路由行为一致。

## 安全与错误处理

- Route、Action、Webhook 与第三方响应都要验证输入，不吞掉异常。
- 资源读取和修改必须同时检查 principal、角色和归属；UI 菜单隐藏不等于权限校验。
- 面向用户的错误信息需要可理解，服务端错误应通过 logger 记录可定位上下文但不泄露密钥。
- 可选基础设施未配置时应明确降级，不能因 observability 或 cache 缺失破坏核心流程。

## 领域模式

- 新功能先定义 UOL `defineOperation()`，再通过 Action、API、cron 或 webhook 做薄适配。
- 账务、配额、工单等具有副作用的写入必须携带可追踪的幂等键。
- 选择已存在的 feature service 和 repository 模式，不从页面直接导入数据库。
- 修改可运营系统配置时，同步 definitions、默认值测试和管理面板。

## Git 约定

- 使用 Conventional Commit 格式，摘要简洁且正文解释原因。
- 不用跳过钩子或破坏性 git 命令绕开验证。
- `AGENTS.md` 与 `CLAUDE.md` 必须逐字保持同步；改动其中之一必须同步另一份。

---
*最后分析：2026-08-17*
