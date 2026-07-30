/**
 * API 账号上游适配配置契约。
 *
 * 职责：约束平台模型到账号上游模型的稀疏映射，以及同步 JavaScript 请求处理脚本。
 * 使用方：统一账号保存 UOL、管理端表单、运行时 API Images/Videos 适配器。
 * 本模块只处理配置与模型 ID，不执行脚本，也不接触账号凭据或网络。
 */
import { z } from "zod";

/** 单个 API 账号允许保存的最大模型映射数量。 */
export const MAX_API_MODEL_MAPPINGS = 1_000;

/** 单个账号请求处理脚本的最大 UTF-16 字符数。 */
export const MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS = 32_768;

/** 平台真实模型 ID 到供应商上游模型 ID 的单条稀疏映射。 */
export const apiModelMappingSchema = z
  .object({
    modelId: z.string().trim().min(1).max(120),
    upstreamModelId: z.string().trim().min(1).max(240),
  })
  .strict();

/**
 * 账号级模型映射集合。
 *
 * 来源按大小写不敏感语义唯一；目标允许重复，以兼容供应商把多个公开模型聚合到同一
 * 上游模型的情况。来源是否属于账号支持模型由成员聚合契约继续校验。
 */
export const apiModelMappingsSchema = z
  .array(apiModelMappingSchema)
  .max(MAX_API_MODEL_MAPPINGS)
  .superRefine((mappings, context) => {
    const sourceIndexes = new Map<string, number>();
    for (const [index, mapping] of mappings.entries()) {
      const key = mapping.modelId.toLowerCase();
      const previousIndex = sourceIndexes.get(key);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [index, "modelId"],
          message: `模型 ID 与第 ${previousIndex + 1} 条映射重复`,
        });
        continue;
      }
      sourceIndexes.set(key, index);
    }
  });

/** 同步 JavaScript 请求处理脚本；空白内容规范为空字符串。 */
export const apiRequestTransformScriptSchema = z
  .string()
  .max(MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS)
  .transform((script) => (script.trim() ? script : ""));

/** 单条 API 账号模型映射。 */
export type ApiModelMapping = z.infer<typeof apiModelMappingSchema>;

/**
 * 清洗数据库或其他不可信来源中的模型映射。
 *
 * @param value - 未知 JSON 值。
 * @returns 完整且来源唯一的映射；非法配置返回空数组并由保存链拒绝继续写入。
 */
export function normalizeApiModelMappings(value: unknown): ApiModelMapping[] {
  const parsed = apiModelMappingsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/**
 * 解析一个 API 账号实际发送给供应商的模型 ID。
 *
 * @param platformModelId - 调度、计费和任务记录使用的平台真实模型 ID。
 * @param mappings - 当前账号的稀疏模型映射。
 * @returns 命中时返回保留供应商格式的上游 ID，否则原样返回平台 ID。
 */
export function resolveApiUpstreamModelId(
  platformModelId: string,
  mappings: unknown
): string {
  const key = platformModelId.trim().toLowerCase();
  const mapping = normalizeApiModelMappings(mappings).find(
    (candidate) => candidate.modelId.toLowerCase() === key
  );
  return mapping?.upstreamModelId ?? platformModelId;
}
