/**
 * UOL Operations - 全域操作注册桶导入
 *
 * 职责：副作用导入所有域操作文件，触发 defineOperation 注册。
 * 应用启动时由 uol/index.ts 或顶层入口 import 此文件，
 * 确保所有操作在 registry 中可用。
 *
 * 新增域时在此追加 import 即可。
 */

// 图像生成域
import "./image-generation";
// 管理状态页历史错误（仅人工管理员）
import "./admin-status";
// 媒体资源限制与用户并发覆盖
import "./media-limits";
// 视频生成与查询（与图片共享 image-generation 域）
import "./video-generation";
// 积分域
import "./credits";
// 用户认证域
import "./user-auth";
// 图像后端池域
import "./image-backend-pool";
// 系统设置域
import "./system-settings";
// 首页营销设置（人工管理员专用）
import "./system-settings-marketing";
// 首页可靠性读取（system-only，不向 Agent 暴露）
import "./homepage-reliability";
// 存储域
import "./storage";
// 内容审核域
import "./moderation";
// 外部 API 辅助域（媒体生成统一使用 image/video operation）
import "./external-api";
// 模型配置与模型广场（人工管理写入、system-only 公开读取）
import "./model-marketplace";

export { listAdminStatusErrors } from "./admin-status";
export type {
  ExternalApiKeyListItem,
  ExternalApiKeySummary,
} from "./external-api";
export {
  getHomepageGenerationSlaStats,
  getHomepageSlaVisibility,
  type HomepageGenerationSlaStatsOutput,
  type HomepageSlaVisibilityOutput,
  homepageGenerationSlaStatsOutputSchema,
  homepageSlaVisibilityOutputSchema,
} from "./homepage-reliability";
export {
  type AdminPoolGroupListInput,
  type AdminPoolGroupListOutput,
  type AdminPoolMemberListInput,
  type AdminPoolMemberListOutput,
  adminPoolGroupListInputSchema,
  adminPoolGroupListOutputSchema,
  adminPoolMemberListInputSchema,
  adminPoolMemberListOutputSchema,
  imageSizeConfigOutputSchema,
  listAdminGroups,
  listAdminMembers,
  listImageSizeConfigs,
  getImageSizeConfigOptions,
  saveImageSizeConfig,
  deleteImageSizeConfig,
} from "./image-backend-pool";
export {
  imageGenerate,
  imageGetAdminHistoryRequestSnapshot,
  imageMaintainHistoryCountProjection,
} from "./image-generation";
export {
  mediaLimitsGetEffective,
  mediaLimitsSetUserConcurrencyOverride,
} from "./media-limits";
export {
  type ModelMarketplacePublicCatalogOutput,
  modelMarketplaceListPublicModels,
  modelMarketplacePublicCatalogOutputSchema,
  settingsDeleteModelConfigurationEntry,
  settingsGetModelConfiguration,
  settingsListModelConfigurations,
  settingsUpdateModelConfigurationEntry,
} from "./model-marketplace";
export {
  settingsGetPaginationConfig,
  settingsGetSiteBranding,
  settingsSetSiteLogo,
  settingsUploadSiteLogo,
} from "./system-settings";
export { settingsSetMarketingSlaVisibility } from "./system-settings-marketing";
export {
  videoGenerate,
  videoGetGeminiOperation,
  videoGetInputs,
  videoGetStatus,
  videoListCapabilities,
  videoRequestAccountInputCleanup,
} from "./video-generation";

// 客服支持域
import "./support";

export {
  getAdminTicketDetail,
  getAllTickets,
  getMyTickets,
  getTicketDetail,
  markAdminTicketSeen,
  markMyTicketSeen,
} from "./support";

// 用户控制台统计
import "./analytics";
// 公开内容索引域
import "./content";
// 管理端运营总览事实采集与初始化
import "./operations-dashboard-facts";
// 运营总览、明细、异步导出与后台维护 operation
import "./operations-dashboard";
// 支付履约恢复任务
import "./payment-fulfillment";
// 管理端支付概览与充值订单
import "./payment";
// 推广码、归因与首充奖励看板
import "./referrals";

export { fulfillCreemTopUp, fulfillEpayTopUp } from "./credits";
export {
  createOperationsExport,
  expireOperationsExports,
  getOperationsDetail,
  getOperationsOverview,
  listOperationsExports,
  openOperationsLocalExportDownload,
  prepareOperationsExportDownload,
  processOperationsExports,
  retryOperationsExport,
} from "./operations-dashboard";
export {
  ensureCurrentOperationsEpoch,
  recordWebVisit,
} from "./operations-dashboard-facts";
export { recoverPaymentFulfillments } from "./payment-fulfillment";
export {
  fulfillAlipayReferralFirstPayment,
  fulfillCreemReferralFirstPayment,
  fulfillEpayReferralFirstPayment,
  getMyReferralDashboard,
  listMyReferralRelationships,
  referralDashboardOutputSchema,
} from "./referrals";
