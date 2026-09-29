/**
 * 开发服务器的运行时配置注入。
 *
 * 使用方：vite.config.ts。生产环境由 Go backend 托管 index.html 时替换 `<!--app-config-->`
 * 占位；Vite 开发服务器没有 Go 参与，这里按本地环境变量写入同形状的配置。
 */
import type { Plugin } from "vite";

export const APP_CONFIG_PLACEHOLDER = "<!--app-config-->";

/** 渲染注入 index.html 的配置脚本；JSON 中的 `<` 转义，避免提前闭合 script。 */
export function renderRuntimeConfigScript(config: Record<string, string>): string {
  const json = JSON.stringify(config).replace(/</gu, "\\u003c");
  return `<script>window.__FLUXMEDIA_CONFIG__=${json}</script>`;
}

export function devRuntimeConfig(env: Record<string, string | undefined>): Plugin {
  return {
    name: "fluxmedia-dev-runtime-config",
    apply: "serve",
    transformIndexHtml(html) {
      const config: Record<string, string> = {};
      if (env.APP_TIME_ZONE) config.appTimeZone = env.APP_TIME_ZONE;
      return html.replace(APP_CONFIG_PLACEHOLDER, renderRuntimeConfigScript(config));
    },
  };
}
