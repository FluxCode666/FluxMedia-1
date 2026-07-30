/**
 * 公开模型广场页面的数据装配边界。
 *
 * 使用方是 `/models` Server Component；生产路径读取 Better Auth 会话，为登录用户构造
 * 真实 Principal，匿名访问继续使用 system Principal。失败统一收窄为 unavailable。
 */
import "server-only";

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import {
  type ModelMarketplacePublicItem,
  modelMarketplacePublicItemSchema,
} from "@repo/shared/model-marketplace";
import { invokeOperation, type Principal } from "@repo/shared/uol";
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
 * 通过 Principal 感知的 UOL operation 读取公开模型目录。
 *
 * @returns 通过 operation 输出 schema 校验的公开 DTO。
 * @sideEffects 读取 Better Auth 会话；登录时读取角色；初始化 Web late binding，并读取
 * 运行时目录、价格、公开展示配置与用户可信分组模型配置。
 * @failure 初始化、operation、依赖或输出校验失败时拒绝 Promise，由页面装配器降级。
 */
async function loadPublicModelsThroughUol(): Promise<PublicCatalogOutput> {
  const session = await getServerSession();
  const principal: Principal = session
    ? {
        type: "user",
        userId: session.user.id,
        role: await getUserRoleById(session.user.id),
      }
    : { type: "system", reason: "public-model-marketplace-page" };
  await ensureUolInitialized();
  return invokeOperation<PublicCatalogOutput>(
    "modelMarketplace.listPublicModels",
    {},
    principal,
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
