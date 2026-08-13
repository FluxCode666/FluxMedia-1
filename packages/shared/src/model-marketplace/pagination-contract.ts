/**
 * 模型配置管理列表的分页契约。
 *
 * 使用方：settings.listModelConfigurations UOL、Web late binding 与管理设置页。
 * 筛选、精确总数和分页信封在统一接口层固定，完整模型广场目录保持不变。
 */

import { z } from "zod";

import { createOffsetPaginationOutputSchema } from "../pagination/contracts";
import { modelConfigurationEntrySchema } from "./contracts";

/** 管理模型列表允许的媒体类别筛选。 */
export const modelConfigurationCategoryFilterSchema = z.enum([
  "all",
  "image",
  "video",
]);

/** 管理模型列表的严格查询输入。 */
export const modelConfigurationListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z
      .union([z.literal(10), z.literal(20), z.literal(50)])
      .default(20),
    query: z.string().trim().max(240).default(""),
    category: modelConfigurationCategoryFilterSchema.default("all"),
  })
  .strict();

/** 管理模型列表的严格分页输出。 */
export const modelConfigurationListOutputSchema =
  createOffsetPaginationOutputSchema(modelConfigurationEntrySchema)
    .extend({
      canEdit: z.boolean(),
      runtimeCatalogStatus: z.enum(["ready", "unavailable"]),
    })
    .strict();

export type ModelConfigurationCategoryFilter = z.output<
  typeof modelConfigurationCategoryFilterSchema
>;
export type ModelConfigurationListInput = z.output<
  typeof modelConfigurationListInputSchema
>;
export type ModelConfigurationListOutput = z.output<
  typeof modelConfigurationListOutputSchema
>;
