// 配置模块统一导出

export {
  adminConfig,
  // Admin 配置
  adminNav,
  dashboardConfig,
  // Dashboard 配置
  dashboardNav,
  footerNav,
  // Marketing 配置
  mainNav,
  marketingConfig,
  type NavGroup,
  // 类型
  type NavItem,
} from "./nav";
export { getBaseUrl, paymentConfig, paymentProvider } from "./payment";
export {
  DEFAULT_SITE_URL,
  getSiteBaseUrl,
  normalizePublicAppUrl,
  resolvePublicAppUrl,
  type PublicAppUrlOptions,
  type SiteConfig,
  siteConfig,
} from "./site";
