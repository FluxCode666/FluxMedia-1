/**
 * 统一媒体运行时分组的 DB-free 信任边界。
 *
 * 职责：合并站内显式选择、服务端固定分组与 API Key 绑定，并拒绝任何外部覆盖
 * 或身份不一致；数据库加载由 runtime-service 负责。
 * 使用方：图片与视频统一运行时会话及其单元测试。
 */
import { BackendSchedulerError } from "./scheduler-error";

/** 分组选择所需的最小运行时身份事实。 */
export interface RuntimeGroupSelectionInput {
  apiKeyId?: string;
  requestedGroupId?: string;
  pinnedGroupId?: string;
}

/** 运行时选择分组所需的最小启用候选事实。 */
export interface RuntimeBackendGroupCandidate {
  id: string;
  isDefault: boolean;
  isUserSelectable: boolean;
}

/**
 * 从已启用候选中选择可信分组。
 *
 * @param candidates 已由数据库过滤为启用状态的分组。
 * @param target 可信目标 ID 及其是否来自站内用户显式选择。
 * @returns 精确目标或唯一默认组；不按 priority 或列表位置兜底。
 * @throws 目标不可用、用户选择不可选组或不存在默认组时 fail closed。
 */
export function selectRuntimeBackendGroupCandidate<
  T extends RuntimeBackendGroupCandidate,
>(
  candidates: readonly T[],
  target: { targetGroupId?: string; isUserRequested?: boolean }
): T {
  if (target.targetGroupId) {
    const candidate = candidates.find(
      (item) => item.id === target.targetGroupId
    );
    if (!candidate) {
      throw new BackendSchedulerError(
        "no_eligible_member",
        "目标媒体后端分组不存在或已停用"
      );
    }
    if (target.isUserRequested && !candidate.isUserSelectable) {
      throw new BackendSchedulerError(
        "no_eligible_member",
        "目标媒体后端分组不可由用户选择"
      );
    }
    return candidate;
  }

  const defaultGroups = candidates.filter((candidate) => candidate.isDefault);
  if (defaultGroups.length === 0) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前没有启用的默认媒体后端分组"
    );
  }
  if (defaultGroups.length > 1) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前存在多个默认媒体后端分组"
    );
  }
  const [defaultGroup] = defaultGroups;
  if (!defaultGroup) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "当前没有启用的默认媒体后端分组"
    );
  }
  return defaultGroup;
}

/**
 * 选择可信运行时分组。
 *
 * @param input 站内选择或 API Key 调用的分组事实。
 * @param apiKeyBinding 已按 Key ID、userId 与启用状态查询的绑定；缺失表示无效 Key。
 * @returns 可信目标分组，以及是否来自站内用户的显式选择。
 * @throws 无效 Key、外部覆盖、双重选择或服务端固定分组漂移时 fail closed。
 */
export function selectTrustedRuntimeGroupTarget(
  input: RuntimeGroupSelectionInput,
  apiKeyBinding?: { groupId: string | null }
): { targetGroupId: string | undefined; isUserRequested: boolean } {
  if (!input.apiKeyId) {
    if (input.requestedGroupId && input.pinnedGroupId) {
      throw new BackendSchedulerError(
        "no_eligible_member",
        "媒体后端分组不能同时显式选择并由服务端固定"
      );
    }
    return {
      targetGroupId: input.requestedGroupId ?? input.pinnedGroupId,
      isUserRequested: Boolean(input.requestedGroupId),
    };
  }
  if (input.requestedGroupId) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "API Key 调用不能覆盖服务端绑定的媒体后端分组"
    );
  }
  if (!apiKeyBinding) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "API Key 无效、已停用或不属于当前用户"
    );
  }
  if (
    apiKeyBinding.groupId &&
    input.pinnedGroupId &&
    apiKeyBinding.groupId !== input.pinnedGroupId
  ) {
    throw new BackendSchedulerError(
      "no_eligible_member",
      "服务端固定分组与 API Key 绑定分组不一致"
    );
  }
  return {
    targetGroupId: apiKeyBinding.groupId ?? input.pinnedGroupId,
    isUserRequested: false,
  };
}
