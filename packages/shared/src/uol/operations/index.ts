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
// 视频生成与查询（与图片共享 image-generation 域）
import "./video-generation";
// 积分域
import "./credits";
// 订阅域
import "./subscription";
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
// 首页平台公开模型目录（system-only，不改变外接 API Key 授权语义）
import "./external-api-platform-model-catalog";

export type { ExternalApiKeySummary } from "./external-api";
export {
  type PlatformModelCatalogOutput,
  platformModelCatalogItemSchema,
  platformModelCatalogOutputSchema,
} from "./external-api-platform-model-catalog";
export {
  getHomepageGenerationSlaStats,
  getHomepageSlaVisibility,
  type HomepageGenerationSlaStatsOutput,
  type HomepageSlaVisibilityOutput,
  homepageGenerationSlaStatsOutputSchema,
  homepageSlaVisibilityOutputSchema,
} from "./homepage-reliability";
export { imageGenerate } from "./image-generation";
export { settingsSetMarketingSlaVisibility } from "./system-settings-marketing";
export { videoGenerate, videoGetStatus } from "./video-generation";

// 客服支持域
import "./support";
// 用户控制台统计
import "./analytics";
