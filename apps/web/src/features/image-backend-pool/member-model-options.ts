/**
 * 统一号池成员的模型选项映射与保存校验。
 *
 * 使用方是成员管理表单和 `pool.saveMember` UOL binding。本模块只消费模型配置管理
 * 快照：图像条目直接使用管理配置键，视频条目只使用全局能力目录中的真实模型 ID。
 * 它不读取数据库或系统设置，也不根据成员类型推断调度候选。
 */
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import {
  isLegacyVideoModelId,
  normalizeSupportedModelId,
} from "@repo/shared/image-backend/supported-models";
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import {
  normalizeVideoModelId,
  VIDEO_MODEL_CAPABILITY_CATALOG,
} from "@repo/shared/video-generation";

/** 成员表单可选择的一条真实模型能力。 */
export interface BackendMemberModelOption {
  id: string;
  label: string;
  category: "image" | "video";
  source: "model_configuration" | "existing_member";
}

/**
 * 规范账号池成员卡片可展示的模型身份。
 *
 * @param modelIds - 数据库成员能力快照，可能含迁移前旧视频身份。
 * @returns 大小写无关去重的真实视频 ID 与既有图像 ID；旧视频身份不进入管理界面。
 * @sideEffects 无。
 * @failure 不抛错；空白和超长值沿用共享规范化规则忽略。
 */
export function normalizeBackendMemberModelIdsForDisplay(
  modelIds: readonly string[]
): string[] {
  const normalizedModelIds: string[] = [];
  const seen = new Set<string>();
  for (const rawModelId of modelIds) {
    if (isLegacyVideoModelId(rawModelId)) continue;
    const modelId = normalizeSupportedModelId(rawModelId);
    if (!modelId) continue;
    const key = modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedModelIds.push(modelId);
  }
  return normalizedModelIds;
}

/**
 * 把模型配置管理快照映射为成员可保存的真实模型 ID。
 *
 * @param snapshot - `settings.getModelConfiguration` 返回的严格管理快照。
 * @returns 大小写无关去重后的图像与视频完整模型选项；顺序先遵循管理条目，再遵循
 * 全局视频能力目录。展示开关和价格状态不参与过滤，避免模型广场展示策略影响调度。
 * @sideEffects 无。
 * @failure 不抛错；无法映射到可执行目录的视频族不会伪造模型 ID。
 */
export function buildBackendMemberModelOptions(
  snapshot: ModelConfigurationSnapshot
): BackendMemberModelOption[] {
  const options: BackendMemberModelOption[] = [];
  const seen = new Set<string>();
  const addOption = (option: BackendMemberModelOption): void => {
    const normalizedId = option.id.trim().toLowerCase();
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    options.push({ ...option, id: option.id.trim() });
  };

  for (const entry of snapshot.entries) {
    if (entry.category === "image") {
      addOption({
        id: entry.configKey,
        label: entry.displayName,
        category: "image",
        source: "model_configuration",
      });
      continue;
    }

    const modelId = normalizeVideoModelId(entry.configKey);
    if (!modelId || !VIDEO_MODEL_CAPABILITY_CATALOG[modelId]) continue;
    addOption({
      id: modelId,
      label: entry.displayName,
      category: "video",
      source: "model_configuration",
    });
  }
  return options;
}

/**
 * 查找成员提交中不属于模型配置目录的模型 ID。
 *
 * @param input - 已通过统一成员 schema 的保存输入。
 * @param configuredOptions - 从当前模型配置快照构建的真实选项。
 * @param existingModelIds - 编辑同一成员时允许原样保留的历史图像能力；真实视频 ID
 * 仍必须存在于当前全局目录，旧视频身份不能通过编辑兼容入口继续保存。
 * @returns 保持提交顺序的非法模型 ID；非 Adobe direct 成员仅允许图像选项。
 * @sideEffects 无。
 * @failure 不抛错；调用方根据非空结果转换为稳定 UOL validation_error。
 */
export function findUnavailableBackendMemberModelIds(
  input: BackendMemberInput,
  configuredOptions: readonly BackendMemberModelOption[],
  existingModelIds: readonly string[] = []
): string[] {
  const acceptsVideo = input.type === "adobe" && input.config.mode === "direct";
  const allowedIds = new Set(
    configuredOptions
      .filter((option) => option.category === "image" || acceptsVideo)
      .map((option) => option.id.trim().toLowerCase())
  );
  for (const modelId of existingModelIds) {
    const normalizedId = modelId.trim().toLowerCase();
    if (
      normalizedId &&
      !normalizeVideoModelId(modelId) &&
      !isLegacyVideoModelId(modelId)
    ) {
      allowedIds.add(normalizedId);
    }
  }
  return input.supportedModelIds.filter(
    (modelId) => !allowedIds.has(modelId.trim().toLowerCase())
  );
}

/**
 * 创建仅供编辑表单展示的历史模型选项。
 *
 * @param modelId - 当前成员已保存但不在最新模型配置目录中的 ID。
 * @param category - 由现行可执行视频目录判定后的媒体类别。
 * @returns 明确标记为 existing_member 的只读来源选项。
 * @sideEffects 无。
 * @failure 不抛错；调用方必须先去除目录中已经存在的 ID。
 */
export function createExistingMemberModelOption(
  modelId: string,
  category: "image" | "video"
): BackendMemberModelOption {
  return {
    id: modelId,
    label: modelId,
    category,
    source: "existing_member",
  };
}
