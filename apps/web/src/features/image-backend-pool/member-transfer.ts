import { z } from "zod";

import type { BackendMemberAdminSummary } from "./member-service";

/** 供应商账号配置导出文件的稳定格式标识。 */
export const BACKEND_MEMBER_EXPORT_FORMAT =
  "fluxmedia-backend-members" as const;

/** 当前导出文件版本；新增字段时递增并保留旧版本解析分支。 */
export const BACKEND_MEMBER_EXPORT_VERSION = 1 as const;

/** 单次导入允许的最大账号数，避免管理员误上传过大的批处理文件。 */
export const MAX_BACKEND_MEMBER_IMPORT_COUNT = 500;

/** 管理后台导出文件的最小外层结构。成员内容仍由服务端保存 schema 最终校验。 */
export const backendMemberExportDocumentSchema = z
  .object({
    format: z.literal(BACKEND_MEMBER_EXPORT_FORMAT),
    version: z.literal(BACKEND_MEMBER_EXPORT_VERSION),
    exportedAt: z.string().datetime(),
    members: z
      .array(z.unknown())
      .min(1, "导出文件至少要包含一个供应商账号")
      .max(MAX_BACKEND_MEMBER_IMPORT_COUNT, "一次最多导入 500 个供应商账号"),
  })
  .strict();

/** 可下载的供应商账号导出文档；不包含 API Key、Cookie 等凭据。 */
export type BackendMemberExportDocument = z.infer<
  typeof backendMemberExportDocumentSchema
>;

/** 从脱敏列表配置中构造可再次提交给成员保存 schema 的配置。 */
function toPortableMember(
  member: BackendMemberAdminSummary
): Record<string, unknown> {
  const common = {
    id: member.id,
    name: member.name,
    type: member.type,
    groupIds: member.groupIds,
    supportedModelIds: member.supportedModelIds,
    ...(member.supportedResolutionsByModel
      ? { supportedResolutionsByModel: member.supportedResolutionsByModel }
      : {}),
    contentSafetyEnabled: member.contentSafetyEnabled,
    isEnabled: member.isEnabled,
    alwaysActive: member.alwaysActive,
    failureCooldownEnabled: member.failureCooldownEnabled,
    priority: member.priority,
    concurrency: member.concurrency,
  };

  if (member.type === "api") {
    const {
      hasApiKey: _hasApiKey,
      currentAdapterVersion,
      imageSizeConfig,
      imageSizeConfigsByModel,
      ...config
    } = member.config;
    return {
      ...common,
      config: {
        ...config,
        ...(imageSizeConfig?.id
          ? { imageSizeConfigId: imageSizeConfig.id }
          : {}),
        imageSizeConfigIdsByModel: Object.fromEntries(
          Object.entries(imageSizeConfigsByModel ?? {}).flatMap(
            ([modelId, snapshot]) =>
              snapshot?.id ? [[modelId, snapshot.id]] : []
          )
        ),
        ...(currentAdapterVersion
          ? { expectedCurrentVersionId: currentAdapterVersion.id }
          : {}),
      },
    };
  }

  throw new Error("Unsupported backend member type");
}

/** 将选中的脱敏供应商账号序列化为 JSON 下载内容。 */
export function serializeBackendMemberExport(
  members: readonly BackendMemberAdminSummary[],
  exportedAt = new Date().toISOString()
): string {
  const document: BackendMemberExportDocument = {
    format: BACKEND_MEMBER_EXPORT_FORMAT,
    version: BACKEND_MEMBER_EXPORT_VERSION,
    exportedAt,
    members: members.map(toPortableMember),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** 解析导入文件外层结构；每个账号的业务校验在服务端逐条完成。 */
export function parseBackendMemberExportText(
  text: string
):
  | { success: true; document: BackendMemberExportDocument }
  | { success: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { success: false, message: "导入文件不是有效的 JSON" };
  }
  const parsed = backendMemberExportDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "导入文件格式无效",
    };
  }
  return { success: true, document: parsed.data };
}
