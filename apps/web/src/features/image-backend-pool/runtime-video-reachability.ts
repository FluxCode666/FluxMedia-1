/**
 * 视频模型配置可达性的纯投影。
 *
 * 职责：从可信分组的启用成员快照中筛出当前视频状态机可执行的 API 成员，
 * 并稳定去重其真实模型 ID。
 * 使用方：runtime-service 配置可达性查询与 DB-free 契约测试。
 */
import { normalizeVideoModelId } from "@repo/shared/video-generation";

/** 可达性投影所需的最小非敏感成员事实。 */
export interface ConfiguredRuntimeVideoMember {
  memberType: "api";
  supportedModelIds: readonly string[];
}

/**
 * 投影当前视频状态机能够实际获租执行的配置模型 ID。
 *
 * @param members - 已通过分组、启用状态和基础 schema 校验的成员快照。
 * @returns API 成员声明的规范真实模型 ID，保留数据库稳定顺序。
 * @sideEffects 无。
 * @throws 不抛错；非法数据库形状应在调用本函数前由 Zod 拒绝。
 */
export function projectConfiguredVideoModelIds(
  members: readonly ConfiguredRuntimeVideoMember[]
): string[] {
  const modelIds: string[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (member.memberType !== "api") continue;
    for (const rawModelId of member.supportedModelIds) {
      const modelId = normalizeVideoModelId(rawModelId);
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);
      modelIds.push(modelId);
    }
  }
  return modelIds;
}
