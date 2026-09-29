/**
 * Web SPA 构建配置。
 *
 * 产物输出到 dist/，由 Go backend 以 embed 标签编译进二进制并同源托管；开发时
 * Vite 在 :3000 提供页面，并把 API、兼容协议与短链路径代理到本地 Go backend。
 */
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { defineConfig, loadEnv } from "vite";

import { devLocaleRedirect } from "./build/dev-locale-redirect.ts";
import { devRuntimeConfig } from "./build/dev-runtime-config.ts";
import { seoFiles } from "./build/seo-files.ts";
import { siteMeta } from "./build/site-meta.ts";
import * as sourceConfig from "./source.config.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

/** 浏览器可见的公开环境变量；未配置时以空串内联，避免运行时读取 process。 */
const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_AVATARS_BUCKET_NAME",
  "NEXT_PUBLIC_GENERATIONS_BUCKET_NAME",
  "NEXT_PUBLIC_PAYMENT_PROVIDER",
  "NEXT_PUBLIC_EPAY_DEFAULT_PAYMENT_TYPE",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_GA_ID",
] as const;

/** 由 Go backend 处理的路径前缀。 */
const BACKEND_PATHS = ["/api", "/v1", "/v1beta", "/r/", "/moderate", "/healthz", "/readyz"];

export default defineConfig(async ({ mode }) => {
  // 与其它启动命令一致：显式环境变量 > 根目录 .env.local > 根目录 .env。
  const env = { ...loadEnv(mode, repoRoot, ""), ...process.env };
  const nodeEnv = mode === "production" ? "production" : "development";
  const backendTarget = env.GO_BACKEND_URL || "http://localhost:8080";

  const define: Record<string, string> = {
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  };
  for (const key of PUBLIC_ENV_KEYS) {
    define[`process.env.${key}`] = JSON.stringify(env[key] ?? "");
  }
  // 其余 process.env 读取在浏览器中视为未配置，走各自的默认值。
  define["process.env"] = "{}";

  return {
    envDir: repoRoot,
    define,
    plugins: [
      await mdx(sourceConfig, { configPath: "source.config.ts", outDir: ".source" }),
      react(),
      // Vite 插件会按原文件位置改写被内联 CSS（如 fontsource）中的相对 url()，
      // PostCSS 插件不会，字体文件因此不会进入构建产物。
      tailwindcss(),
      devLocaleRedirect(),
      devRuntimeConfig(env),
      siteMeta(env.NEXT_PUBLIC_APP_NAME),
      seoFiles({ webRoot: import.meta.dirname, siteUrl: env.NEXT_PUBLIC_APP_URL }),
    ],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "src"),
        "node:path": resolve(import.meta.dirname, "build/browser-node-path.ts"),
      },
    },
    build: {
      outDir: "dist",
      target: "es2022",
      assetsDir: "static",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
    server: {
      host: "0.0.0.0",
      port: 3000,
      strictPort: true,
      proxy: Object.fromEntries(
        BACKEND_PATHS.map((path) => [path, { target: backendTarget, changeOrigin: false, ws: true }])
      ),
    },
  };
});
