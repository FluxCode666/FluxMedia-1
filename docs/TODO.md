# TODO

只记录尚未完成且可验证的后续工作；已交付能力不在这里保留占位项。

## 发布前

- 在维护窗口执行 `0060_unified_media_backend_pool.sql` 的目标库只读预检，确认旧 Web
  账号、有效租约/粘性绑定和不可恢复的视频任务为空；API、Adobe、子池、关系和历史
  指标必须由迁移保留并转换。
- 为生产环境生成独立高熵 `ADOBE_DIRECT_PROXY_SECRET`，同时配置 Web 与
  `media-upstream-proxy`，不得复用其他服务密钥。
- 在专用 PostgreSQL 数据库运行统一号池迁移、图片调度与视频恢复集成测试。

## 发布后

- 为 `acquired`、`switched`、`no_candidate`、`capacity_rejected` 与
  `terminal_failure` 调度结果建立仪表盘和告警阈值。
- 验证三个全局策略的实际成员分布、租约回收和跨副本容量一致性。
- 定期演练视频 worker 被终止后的租约接管，以及迁移前备份的完整恢复流程。
