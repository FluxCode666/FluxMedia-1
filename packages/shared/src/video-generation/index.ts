/**
 * 中立视频生成能力契约公开入口。
 *
 * 使用方通过 @repo/shared/video-generation 消费真实模型、静态能力和动态覆盖；供应商协议
 * 与数据库访问不从该入口导出，避免公开能力依赖 Adobe 或持久化实现。
 */
export * from "./capability-catalog";
export * from "./capability-overrides";
export * from "./contracts";
export * from "./public-billing";
export * from "./public-capabilities";
