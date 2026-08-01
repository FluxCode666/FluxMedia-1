import { createMDX } from "fumadocs-mdx/next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * 创建 Fumadocs MDX 插件
 */
const withMDX = createMDX();

/**
 * 创建 next-intl 插件
 * 指定国际化请求配置文件路径
 */
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_ASSET_PREFIX || "",
  images: {
    minimumCacheTTL: 2_592_000,
  },
  // Enable standalone output for Docker deployment
  output: "standalone",
  // Next 只 trace onnxruntime-node 的 .node 绑定,不 trace 它运行时 dlopen 的
  // libonnxruntime.so.1(37MB)。standalone 缺它时不只 ISNet 抠图坏:凡 action
  // chunk 引到抠图模块的路由(dashboard/创作页),模块求值即抛错,该路由全部
  // server action 500(2026-06-11 事故:前端积分/套餐被静默回退成 0/免费版)。
  // 此处显式 trace 进 standalone,Docker 与裸机部署都不再需要手工补拷;
  // ISNet 模型同理显式声明,不依赖隐式 trace。版本号用通配,升级 onnxruntime
  // 后无需改这里。
  // sharp 同理:Next 只 trace 它的 .node 绑定,不 trace @img/sharp-libvips-linux-x64
  // 运行时 dlopen 的 libvips-cpp.so.*(约 18MB)。standalone 缺它时 sharp 加载即
  // 抛「Could not load the sharp module」,而存储路由 /api/storage 顶层 import sharp
  // → 整路由 500 → 所有图片下载/缩略图全挂(2026-06-22 事故:dependabot 升 sharp
  // 0.34→0.35 后,新版 libvips 1.3.1 的 .so 未被 trace,客户 image_url 下载 500、
  // 拿不到图)。版本号用通配,升级 sharp 后无需改这里;同时显式带 .node 绑定。
  outputFileTracingIncludes: {
    "/*": [
      "../../node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**",
      "./models/isnet.onnx",
      "./models/realesr-general-x4v3.onnx",
      "./models/scunet-color-real-gan.onnx",
      "../../node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/**",
      "../../node_modules/.pnpm/@img+sharp-linux-x64@*/node_modules/@img/sharp-linux-x64/**",
      // Worker 入口使用静态 URL，但它在独立 Node 线程中自行解析 QuickJS；显式
      // trace 源入口、JS 桥接与 WASM，防止 standalone 镜像只包含主服务 chunk。
      "./src/features/image-backend-pool/api-upstream-script-worker.mjs",
      "./scripts/api-upstream-worker-probe.mjs",
      "./scripts/preflight-api-upstream-adapter-migration.mjs",
      "./scripts/smoke-api-upstream-worker.mjs",
      "../../node_modules/.pnpm/quickjs-emscripten@*/node_modules/quickjs-emscripten/dist/**",
      "../../node_modules/.pnpm/quickjs-emscripten-core@*/node_modules/quickjs-emscripten-core/dist/**",
      "../../node_modules/.pnpm/@jitl+quickjs-ffi-types@*/node_modules/@jitl/quickjs-ffi-types/dist/**",
      "../../node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@*/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/**",
      "../../node_modules/.pnpm/@jitl+quickjs-wasmfile-debug-sync@*/node_modules/@jitl/quickjs-wasmfile-debug-sync/**",
      "../../node_modules/.pnpm/@jitl+quickjs-wasmfile-debug-asyncify@*/node_modules/@jitl/quickjs-wasmfile-debug-asyncify/**",
      "../../node_modules/.pnpm/@jitl+quickjs-wasmfile-release-asyncify@*/node_modules/@jitl/quickjs-wasmfile-release-asyncify/**",
    ],
  },
  experimental: {
    proxyClientMaxBodySize: "200mb",
    serverActions: {
      bodySizeLimit: "200mb",
    },
  },
  // Transpile monorepo packages
  transpilePackages: ["@repo/ui", "@repo/database", "@repo/shared"],
  // Exclude packages with webpack-specific syntax from server bundling
  serverExternalPackages: [
    "anki-apkg-export",
    "sql.js",
    "pino",
    "pino-pretty",
    "@axiomhq/pino",
    // 系统设置共享缓存使用 Node TCP 连接与连接池；保持外置以便 standalone
    // 完整复制 ioredis 的命令表、解析器与可选运行时依赖。
    "ioredis",
    // 原生模块（存储路由的按需缩略图缩放）：保持外置，避免被打进 server bundle。
    "sharp",
    // 透明背景兜底使用的原生抠图引擎；外置以避免打进 server bundle，
    // Next 会把各平台预编译模块复制到 standalone node_modules。
    "onnxruntime-node",
  ],
};

// 组合插件: MDX -> NextIntl -> NextConfig
export default withMDX(withNextIntl(nextConfig));
