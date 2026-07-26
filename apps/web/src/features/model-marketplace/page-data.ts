/**
 * 公开模型广场页面的数据装配边界。
 *
 * 使用方是 `/models` Server Component；生产路径只初始化 UOL 并调用公开目录 operation，
 * 不读取会话、角色、SLA 或管理设置，失败统一收窄为 unavailable。
 */
import "server-only";

import {
  type ModelMarketplacePublicItem,
  modelMarketplacePublicItemSchema,
} from "@repo/shared/model-marketplace";
import { invokeOperation } from "@repo/shared/uol";
import { z } from "zod";

import { ensureUolInitialized } from "@/server/uol-init";

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
 * 通过 system-only UOL operation 读取公开模型目录。
 *
 * @returns 通过 operation 输出 schema 校验的公开 DTO。
 * @sideEffects 初始化 Web late binding，并读取运行时目录、价格和公开展示配置。
 * @failure 初始化、operation、依赖或输出校验失败时拒绝 Promise，由页面装配器降级。
 */
async function loadPublicModelsThroughUol(): Promise<PublicCatalogOutput> {
  await ensureUolInitialized();
  return invokeOperation<PublicCatalogOutput>(
    "modelMarketplace.listPublicModels",
    {},
    { type: "system", reason: "public-model-marketplace-page" },
    { requestId: crypto.randomUUID() }
  );
}

/**
 * 装配公开模型广场页面数据。
 *
 * @param loadModels - 可注入的公开目录读取器；生产默认值只走 UOL。
 * @returns 严格 ready DTO 或稳定 unavailable，不泄露底层错误。
 * @sideEffects 生产默认读取器会初始化 UOL 并查询运行时依赖；本函数不写外部状态。
 * @failure 任意异常或畸形输出统一返回 unavailable，成功空数组保持 ready。
 */
export async function loadModelMarketplacePageData(
  loadModels: ModelMarketplacePageDataLoader = loadPublicModelsThroughUol
): Promise<ModelMarketplacePageData> {
  try {
    const output = publicCatalogOutputSchema.parse(await loadModels());
    return { status: "ready", models: output.items };
  } catch {
    return { status: "unavailable" };
  }
}
