/**
 * 合并式页面生图的纯状态规则。
 *
 * 使用方：创作页通过这些函数把主参考图、可选蒙版和已选模型转换为可展示、可提交的
 * 单一生图状态。关键依赖：不依赖 React 或网络，使参考图替换和模型兼容性可独立测试。
 */
import type {
  ImageGenerationCatalogModel,
  ImageGenerationModelCapabilities,
} from "@/features/image-backend-pool/image-generation-model-catalog";

/** 合并表单中由主参考图和蒙版决定的请求模式。 */
export type UnifiedImageGenerationMode =
  | "text-to-image"
  | "image-to-image"
  | "masked-edit";

/** 目录模型在合并表单中需要满足的能力。 */
export type UnifiedModelRequirement = keyof ImageGenerationModelCapabilities;

/**
 * 解析页面请求应携带的混合分组 Web-first 偏好。
 *
 * @param isSimpleImageGenerationPage - 当前是否为无高级路由设置的简易生图页。
 * @param legacyMixWebFirstActive - 旧创作页当前尺寸与分组下是否启用了 Web-first。
 * @returns 简易生图页始终显式返回 false；旧创作页仅在已启用时返回 true，否则省略字段。
 * @remarks 服务端为兼容外部 API 将省略的该字段视作 true。因此简易页必须显式传 false，
 * 不能只隐藏尺寸弹窗里的开关；旧创作页保留原有尺寸范围与用户偏好行为。
 */
export function resolvePageMixWebFirstPreference(
  isSimpleImageGenerationPage: boolean,
  legacyMixWebFirstActive: boolean
): boolean | undefined {
  if (isSimpleImageGenerationPage) return false;
  return legacyMixWebFirstActive ? true : undefined;
}

/**
 * 根据附件状态得出唯一的生成模式。
 *
 * @param hasReference - 是否已有一张主参考图。
 * @param hasMask - 是否已有与主图绑定的蒙版。
 * @returns 文生图、图生图或局部编辑模式。
 * @remarks 没有主图时忽略孤立蒙版，避免 UI 残留影响请求语义。
 */
export function getUnifiedImageGenerationMode(params: {
  hasReference: boolean;
  hasMask: boolean;
}): UnifiedImageGenerationMode {
  if (!params.hasReference) return "text-to-image";
  return params.hasMask ? "masked-edit" : "image-to-image";
}

/**
 * 得出当前附件状态对目录模型提出的最低能力要求。
 *
 * @param mode - 当前统一生成模式。
 * @returns 必须具备的目录能力键。
 */
export function getRequiredUnifiedModelCapability(
  mode: UnifiedImageGenerationMode
): UnifiedModelRequirement {
  if (mode === "text-to-image") return "generate";
  if (mode === "masked-edit") return "mask";
  return "edit";
}

/**
 * 判断一个授权目录模型能否服务当前统一生成状态。
 *
 * @param model - 当前选中的授权目录模型；缺失模型一律不可提交。
 * @param mode - 当前统一生成模式。
 * @returns 是否允许显示为可提交。
 * @remarks 这是客户端预检，服务端仍需以实际分组和模型重新授权。
 */
export function canModelServeUnifiedImageGeneration(
  model: ImageGenerationCatalogModel | null,
  mode: UnifiedImageGenerationMode
) {
  if (!model) return false;
  return model.capabilities[getRequiredUnifiedModelCapability(mode)];
}

/**
 * 生成稳定的分组模型选择值，避免模型名相同却归属不同分组时发生串组。
 *
 * @param groupId - 授权目录的分组 ID。
 * @param modelId - 该分组内的模型 ID。
 * @returns 仅供客户端 Select 使用的编码值。
 */
export function createUnifiedModelSelectionValue(
  groupId: string,
  modelId: string
) {
  return JSON.stringify([groupId, modelId]);
}

/**
 * 解析客户端 Select 的分组模型值。
 *
 * @param value - 可能来自 localStorage 或 Select 事件的未受信任值。
 * @returns 合法的分组和模型 ID；非法值返回 null。
 */
export function parseUnifiedModelSelectionValue(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !parsed[0].trim() ||
      !parsed[1].trim()
    ) {
      return null;
    }
    return { groupId: parsed[0], modelId: parsed[1] };
  } catch {
    return null;
  }
}
