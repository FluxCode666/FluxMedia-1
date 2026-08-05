/**
 * 统一媒体后端分组契约。
 *
 * 职责：为 UOL、管理后台和数据库服务提供唯一的分组输入、脱敏摘要与 metadata
 * 解析规则。分组只表达内容安全、计费覆盖、层级和任务队列优先级，不再携带套餐
 * 门槛或 Web/Responses 调度车道。
 */
import { z } from "zod";

import { videoModelCreditsPerSecondMapSchema } from "../adobe/video-pricing";
import { imageCreditOverridesSchema } from "./group-image-pricing";

/** 分组级内容安全覆盖；inherit 表示沿用成员设置。 */
export const backendGroupContentSafetySchema = z.enum([
  "inherit",
  "enabled",
  "disabled",
]);

/** 统一分组保存输入；priority 数值越小表示任务队列优先级越高。 */
export const backendGroupInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).optional(),
    isEnabled: z.boolean(),
    isDefault: z.boolean(),
    isUserSelectable: z.boolean(),
    contentSafety: backendGroupContentSafetySchema,
    imageCreditOverrides: imageCreditOverridesSchema,
    videoCreditOverrides: videoModelCreditsPerSecondMapSchema,
    childGroupIds: z.array(z.string().trim().min(1).max(128)).max(100),
    priority: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.childGroupIds).size === input.childGroupIds.length) {
      return;
    }
    context.addIssue({
      code: "custom",
      path: ["childGroupIds"],
      message: "A backend group cannot contain duplicate child groups",
    });
  });

/** 统一分组保存输入类型。 */
export type BackendGroupInput = z.infer<typeof backendGroupInputSchema>;

/** 分组 metadata 中当前仍受支持的治理和计费字段。 */
export const backendGroupMetadataSchema = z
  .object({
    imageCreditOverrides: imageCreditOverridesSchema,
    videoCreditOverrides: videoModelCreditsPerSecondMapSchema,
    childGroupIds: z.array(z.string().trim().min(1).max(128)).max(100),
  })
  .strict();

/** 统一分组 metadata 类型。 */
export type BackendGroupMetadata = z.infer<typeof backendGroupMetadataSchema>;

/** 管理后台可回填全部编辑字段的分组摘要。 */
export const backendGroupSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    isEnabled: z.boolean(),
    isDefault: z.boolean(),
    isUserSelectable: z.boolean(),
    contentSafety: backendGroupContentSafetySchema,
    imageCreditOverrides: imageCreditOverridesSchema,
    videoCreditOverrides: videoModelCreditsPerSecondMapSchema,
    childGroupIds: z.array(z.string()),
    priority: z.number().int().min(0).max(10_000),
  })
  .strict();

/** 统一分组管理摘要类型。 */
export type BackendGroupSummary = z.infer<typeof backendGroupSummarySchema>;

/** 用户或成员表单使用的最小分组选项。 */
export const backendGroupOptionSchema = z
  .object({ id: z.string(), name: z.string() })
  .strict();

/** 把表单内容安全覆盖转换为数据库可空布尔值。 */
export function toBackendGroupContentSafety(
  value: z.infer<typeof backendGroupContentSafetySchema>
): boolean | null {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

/** 把数据库可空布尔值转换为表单内容安全覆盖。 */
export function fromBackendGroupContentSafety(
  value: boolean | null
): z.infer<typeof backendGroupContentSafetySchema> {
  if (value === true) return "enabled";
  if (value === false) return "disabled";
  return "inherit";
}

/**
 * 解析持久化分组 metadata。
 *
 * @param value 数据库中的不可信 JSON。
 * @returns 严格合法的当前 metadata；旧值或脏值按安全默认值恢复。
 */
export function parseBackendGroupMetadata(
  value: unknown
): BackendGroupMetadata {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const parsed = backendGroupMetadataSchema.safeParse({
    imageCreditOverrides: source.imageCreditOverrides ?? {
      version: 1,
      byModel: {},
    },
    videoCreditOverrides: source.videoCreditOverrides ?? {},
    childGroupIds: source.childGroupIds ?? [],
  });
  if (parsed.success) return parsed.data;
  return {
    imageCreditOverrides: { version: 1, byModel: {} },
    videoCreditOverrides: {},
    childGroupIds: [],
  };
}

/** 从已校验保存输入构造唯一受支持的持久化 metadata。 */
export function createBackendGroupMetadata(
  input: BackendGroupInput
): BackendGroupMetadata {
  return {
    imageCreditOverrides: input.imageCreditOverrides,
    videoCreditOverrides: input.videoCreditOverrides,
    childGroupIds: input.childGroupIds,
  };
}
