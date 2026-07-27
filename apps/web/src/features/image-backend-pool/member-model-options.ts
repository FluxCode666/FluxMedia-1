/**
 * 统一号池成员的模型选项映射与保存校验。
 *
 * 使用方是成员管理表单和 `pool.saveMember` UOL binding。本模块只消费模型配置管理
 * 快照：图像条目直接使用管理配置键，视频条目按模型族展开为 Firefly 可执行完整 ID。
 * 它不读取数据库或系统设置，也不根据成员类型推断调度候选。
 */
import {
  FIREFLY_VIDEO_MODEL_CATALOG,
  type FireflyVideoModelConf,
} from "@repo/shared/adobe/firefly-direct/video-catalog";
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";

/** 成员表单可选择的一条真实模型能力。 */
export interface BackendMemberModelOption {
  id: string;
  label: string;
  category: "image" | "video";
  source: "model_configuration" | "existing_member";
}

/**
 * 格式化视频完整模型 ID 的人类可读选项。
 *
 * @param displayName - 模型配置中的视频族展示名。
 * @param configuration - 完整模型 ID 对应的可执行 Firefly 配置。
 * @returns 包含时长、比例和分辨率的稳定标签。
 * @sideEffects 无。
 * @failure 不抛错；参数均来自严格模型配置与静态视频目录。
 */
function formatVideoModelOptionLabel(
  displayName: string,
  configuration: FireflyVideoModelConf
): string {
  return [
    displayName,
    `${configuration.duration}s`,
    configuration.aspectRatio,
    configuration.outputResolution,
  ].join(" · ");
}

/**
 * 把模型配置管理快照展开为成员可保存的完整模型 ID。
 *
 * @param snapshot - `settings.getModelConfiguration` 返回的严格管理快照。
 * @returns 大小写无关去重后的图像与视频完整模型选项；顺序先遵循管理条目，再遵循
 * 静态视频目录。展示开关和价格状态不参与过滤，避免模型广场展示策略影响调度。
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

    for (const [modelId, configuration] of Object.entries(
      FIREFLY_VIDEO_MODEL_CATALOG
    )) {
      if (configuration.family !== entry.configKey) continue;
      addOption({
        id: modelId,
        label: formatVideoModelOptionLabel(entry.displayName, configuration),
        category: "video",
        source: "model_configuration",
      });
    }
  }
  return options;
}

/**
 * 查找成员提交中不属于模型配置目录的模型 ID。
 *
 * @param input - 已通过统一成员 schema 的保存输入。
 * @param configuredOptions - 从当前模型配置快照构建的真实选项。
 * @param existingModelIds - 编辑同一成员时允许原样保留的历史能力；只用于兼容已迁移
 * 数据，不能让新增成员提交任意 ID。
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
    if (normalizedId) allowedIds.add(normalizedId);
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
