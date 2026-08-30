# TODO

只记录尚未完成且可验证的后续工作；已交付能力不在这里保留占位项。

## 发布前

- 继续模型广场的非本次核心浏览器验收：两会话 revision 冲突、幂等重放、封面上传/替换/
  移除、中英文响应式详情、复制与焦点、登录回跳、visible 与 `/v1/models`/创作目录隔离，
  以及匿名模型资产不会扩大 generations 私有访问。受控 PostgreSQL 下的管理员列表、保存、
  Seedance 动态参考图上限、能力摘要与内置简介保留已经通过。
- 使用可控或真实上游完成 Seedance 首尾帧任务和 10 张以上参考图任务，随后以用户和管理员
  历史详情验证实际输入图授权、callback 只含模式与数量，以及任务或账号删除后的持久清理。
  创作页已经验证两种输入模式切换会清空另一模式文件，账号池六操作、真实模型映射、无网络
  QuickJS、模型选择滚轮、HTTP Base URL、保存与手动重置状态也已有真实浏览器证据。
- 构建 `Dockerfile.web` 的最终 runner 镜像并执行
  `pnpm --filter @repo/web smoke:api-upstream-container`。本地已通过 production build、standalone
  资产断言和 Node 22 Worker smoke；当前 Docker Hub 匿名鉴权端点 IPv6 连接超时，基础镜像
  `node:22-slim` 尚未拉取，需网络恢复后重试或由 PR CI 的同一门禁完成。
- 在维护窗口执行 `0060_unified_media_backend_pool.sql` 的目标库只读预检，确认旧 Web
  账号、有效租约/粘性绑定和不可恢复的视频任务为空；API、子池、关系和历史指标必须
  由迁移保留并转换。另须确认没有 Responses 型 API、非法模型元素或成员 ID 冲突；
  Images `use_stream` 配置应保留。
- 在生产维护窗口排空旧 Web/worker 并冻结账号配置写入，完成备份/PITR 证据、视频输入资产
  收编、0074 与 0077 preflight、迁移及 postcheck；迁移开始后如需回退，必须成对恢复旧镜像
  与数据库，不能只回退应用。

## 发布后

- 为 `acquired`、`switched`、`no_candidate`、`capacity_rejected` 与
  `terminal_failure` 调度结果建立仪表盘和告警阈值。
- 验证三个全局策略的实际成员分布、租约回收和跨副本容量一致性。
- 定期演练视频 worker 被终止后的租约接管，以及迁移前备份的完整恢复流程。
