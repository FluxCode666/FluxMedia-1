/**
 * 模型广场共享入口。
 *
 * Web、UOL 与后续适配层统一从该包子路径导入契约和 DB-free 规则，避免依赖 shared 包内部
 * 文件布局。
 */
export * from "./catalog";
export * from "./availability";
export * from "./contracts";
export * from "./pagination-contract";
