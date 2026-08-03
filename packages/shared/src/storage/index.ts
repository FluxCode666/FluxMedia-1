// Storage System
// NOTE: ./providers 与 ./signed-url 刻意不从此 barrel re-export。
// - ./providers 使用 Node.js-only API（fs、path、@aws-sdk），只能被服务端代码
//   （server actions、API routes）直接 import。
// - ./signed-url 顶层 import node:crypto：经 barrel 泄漏进客户端会把整套
//   crypto-browserify polyfill（约 450KB raw）打进 authed 公共包（2026-07 实测
//   每页 +46%）。服务端一律走深路径 @repo/shared/storage/signed-url。
// 客户端可安全从本 barrel import types、utils、actions 与 image-url 纯工具。
export * from "./actions";
export * from "./bucket-config";
export * from "./image-url";
export * from "./types";
export * from "./utils";
