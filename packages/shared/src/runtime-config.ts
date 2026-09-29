/**
 * 部署运行时配置。
 *
 * 使用方：需要读取部署级设置的浏览器代码。Go backend 托管 index.html 时把配置写入
 * `window.__FLUXMEDIA_CONFIG__`，开发时由 Vite 插件按环境变量写入；因此同一份构建
 * 产物可以部署到不同环境，而无需在构建期内联这些值。
 */

export type RuntimeConfig = {
  /** 部署默认展示时区（APP_TIME_ZONE）。 */
  appTimeZone?: string;
};

declare global {
  interface Window {
    __FLUXMEDIA_CONFIG__?: RuntimeConfig;
  }
}

/** 读取 index.html 注入的运行时配置；非浏览器环境返回空配置。 */
export function getRuntimeConfig(): RuntimeConfig {
  if (typeof window === "undefined") return {};
  return window.__FLUXMEDIA_CONFIG__ ?? {};
}
