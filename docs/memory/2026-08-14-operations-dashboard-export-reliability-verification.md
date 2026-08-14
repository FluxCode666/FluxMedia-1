<!-- 本文记录运营总览 CSV 导出在本地 PostgreSQL 与 local provider 上的可靠性演练证据。 -->

# 运营总览导出可靠性验证记录

验证日期为 2026-08-14。数据库使用本地 PostgreSQL 18.4，应用与数据库会话按 UTC
解释无时区时间戳，产品日期语义使用 `Asia/Shanghai`。临时数据库夹具统一使用
`codex-ops-runtime-20260814-*` 前缀，临时对象目录为单独的 `/tmp` 路径；演练完成后
数据库行与对象目录均已精确清理。

## 大文件流式导出

- 使用真实 local storage provider 生成 250,000 行内容生产 CSV。
- 文件大小为 32,938,990 字节，输出行数、累计字节数和 SHA-256 校验和均与 worker
  完成记录一致。
- 采样到的 RSS 峰值增量为 12,746,752 字节，明显低于最终 CSV 大小；导出通过流式
  编码和写入完成，没有把完整文件聚合为单个内存 `Buffer`。
- 完成后对象前缀中只有最终对象，没有 `.tmp` 或其它中间文件残留。

该结果证明本地 provider 与 worker 的流式链路可处理大于进程峰值增量的文件，但不代表
生产规模 p95，也不替代真实 S3 multipart 的网络与限流演练。

## 两进程租约恢复

- 第一个独立 Node 进程认领任务，`attempt_count` 为 1；租约到期前第二进程无法认领。
- 模拟旧进程退出并推进租约过期后，第二个独立 Node 进程以新 fencing token 恢复任务，
  `attempt_count` 增至 2。
- 恢复进程从真实 PostgreSQL 通过 keyset 分页导出 3,001 行，跨 4 个读取页，最终 CSV
  为 414,238 字节。
- 新 token 完成后，旧 token 的完成与失败更新均影响 0 行，不能覆盖新结果。

运营导出恢复不依赖 Redis。任务状态、租约、attempt 与 fencing token 的可靠性事实全部
位于 PostgreSQL；Redis 重启或连通性不能作为本导出恢复的证明。

## 七天边界与删除失败恢复

- `expires_at - 1ms` 仍可准备下载；到达 `expires_at` 的同一毫秒即拒绝下载。
- 清理任务先把记录标记为 `expired`，再删除对象。第一次模拟存储不可用时，任务保持
  `expired`，`cleanup_error_code` 为 `object_delete_failed`，且不写
  `object_deleted_at`。
- 下一批清理恢复后对象被删除，写入 `object_deleted_at`，并清除
  `cleanup_error_code`。

演练脚本使用 PostgreSQL epoch 读取边界。原因是原生 `pg` 对无时区 `timestamp` 的默认
Date 解析会受 Node 进程时区影响，而产品 Drizzle 连接统一采用 UTC 语义；边界验证不能
混用两套解析方式。

## 硬崩溃后的孤儿对象清理

- local 与 S3 provider 均支持有界对象前缀分页；S3 同时支持枚举并中止未完成 multipart
  upload。
- 清理只处理超出租约保护窗口、未被数据库任务引用、且不属于活跃租约 token 的对象。
- 已完成或已过期任务仍引用的对象、活跃长上传，以及保护窗口内的新对象均会保留。
- local provider 能发现陈旧 `.tmp` 文件，并逐路径段拒绝 bucket 父级符号链接逃逸。
- 对象分页、multipart 中止、引用保护、活跃租约保护、陈旧临时文件和路径逃逸均有定向
  Vitest 覆盖。

## 自动验证结果

- shared storage provider：2 个测试文件，19 个用例通过。
- Web 导出、CSV、scheduler 与下载链路：8 个测试文件，46 个用例通过。
- `@repo/shared` 与 `@repo/web` TypeScript typecheck 通过。
- 相关文件 Biome check 通过。
- 隔离 Playwright 完整套件 28/28 通过，其中真实导出链路覆盖三类创建入口、
  completed/failed/expired 状态、failed 重试、expired 重新生成、完成通知只出现一次，
  以及签名 cursor 从首屏 20 条加载至 24 条。
- completed 下载返回真实 UTF-8 BOM CSV 和建议文件名；浏览器读取文件并核对表头与
  测试用户邮箱，数据库审计依次记录 `granted`、`started`。expired 下载路由返回 404。
- 下载对象的 SHA-256、行数、字节数来自实际写入内容，并与
  `operations_export_task` 中的完成事实一致。

## 未覆盖边界

- 未连接真实 S3 或 MinIO；当前 S3 证据为 AWS SDK 命令级单元测试，尚未覆盖真实
  multipart 网络中断、凭据失效、服务端分页和限流。
- 本地数据量用于验证流式内存形状和恢复语义，不足以关闭生产跨多年查询 p95、buffers
  与对象存储吞吐门禁。

## 清理结果

演练结束后，临时用户、导出任务、内容事实和审计记录计数均为 0，临时存储目录不存在，
临时验收脚本已从工作树删除。浏览器验收结束后固定用户、account、session 和导出任务
均为 0，端口 3107 已释放，隔离 storage 目录不存在；应用启动产生的三个 Redis 元数据
键按精确键名删除后，专用逻辑库 15 的 `DBSIZE` 为 0。
