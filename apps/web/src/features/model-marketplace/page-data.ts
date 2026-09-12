/**
 * 公开模型广场页面的数据装配边界。
 *
 * 使用方是 `/models` Server Component；生产路径读取 Better Auth 会话，为登录用户构造
 * 真实 Principal，匿名访问继续使用 system Principal。失败统一收窄为 unavailable。
 */
import "server-only";

import {
  type ModelMarketplacePublicItem,
  modelMarketplacePublicItemSchema,
} from "@repo/shared/model-marketplace";
import { z } from "zod";

import { requestGoJson } from "@/server/go-backend-client";

/** 模型广场页面显式区分成功空目录与依赖不可用。 */
export type ModelMarketplacePageData =
  | { status: "ready"; models: ModelMarketplacePublicItem[] }
  | { status: "unavailable" };

/** 测试可注入的唯一公开目录读取器。 */
export type ModelMarketplacePageDataLoader = () => Promise<unknown>;

const publicCatalogOutputSchema = z
  .object({ items: z.array(modelMarketplacePublicItemSchema).max(500) })
  .strict();
type PublicCatalogOutput = z.infer<typeof publicCatalogOutputSchema>;

/**
 * 通过 Go first-party endpoint 读取公开模型目录。
 *
 * @returns 通过 operation 输出 schema 校验的公开 DTO。
 * @sideEffects 读取 Go 后端中的运行时目录、价格、公开展示配置与可达模型配置。
 * @failure 初始化、operation、依赖或输出校验失败时拒绝 Promise，由页面装配器降级。
 */
async function loadPublicModelsThroughGo(): Promise<PublicCatalogOutput> {
  return requestGoJson<PublicCatalogOutput>("/api/model-marketplace/public");
}

/**
 * 装配公开模型广场页面数据。
 *
 * @param loadModels - 可注入的公开目录读取器；生产默认值只走 Go。
 * @returns 严格 ready DTO 或稳定 unavailable，不泄露底层错误。
 * @sideEffects 生产默认读取器会初始化 UOL 并查询运行时依赖；本函数不写外部状态。
 * @failure 任意异常或畸形输出统一返回 unavailable，成功空数组保持 ready。
 */
export async function loadModelMarketplacePageData(
  loadModels: ModelMarketplacePageDataLoader = loadPublicModelsThroughGo
): Promise<ModelMarketplacePageData> {
  try {
    const output = publicCatalogOutputSchema.parse(await loadModels());
    return { status: "ready", models: output.items };
  } catch {
    return { status: "unavailable" };
  }
}
