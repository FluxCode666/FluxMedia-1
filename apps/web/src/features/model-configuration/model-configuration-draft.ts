/**
 * 模型配置编辑弹窗的 DB-free 草稿与 multipart 组装规则。
 *
 * 使用方是管理端编辑 Dialog；本模块把共享管理 DTO 转成可编辑字符串，维护一次保存尝试
 * 的幂等 UUID，并生成 Task 5 Route 接受的严格 FormData，不发请求、不访问存储。
 */
import {
  MAX_MODEL_MARKETPLACE_COVER_BYTES,
  MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH,
  MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY,
  type ModelConfigurationEntry,
} from "@repo/shared/model-marketplace";

/** 编辑草稿使用的封面动作。replace 必须同时携带本地 File。 */
export type ModelConfigurationCoverDraft =
  | { action: "keep"; file: null }
  | { action: "remove"; file: null }
  | { action: "replace"; file: File };

type MarketplaceDraftFields = {
  enabled: boolean;
  visible: boolean;
  homepageVisible: boolean;
  homepagePriority: string;
  description: string;
  cover: ModelConfigurationCoverDraft;
};

/** 图像模型四档价格草稿；字符串保留用户尚未提交的输入状态。 */
export type ModelConfigurationImagePricingDraft = {
  base1024Credits: string;
  base1kCredits: string;
  base2kCredits: string;
  base4kCredits: string;
};

/** 管理端编辑弹窗可持有的判别联合草稿。 */
export type ModelConfigurationDraft =
  | ({
      category: "image";
      configKey: string;
      expectedRevision: number;
      clientRequestId: string;
      pricing: ModelConfigurationImagePricingDraft;
    } & MarketplaceDraftFields)
  | ({
      category: "video";
      configKey: string;
      expectedRevision: number;
      clientRequestId: string;
      creditsPerSecondByResolution: Record<string, string>;
      maxReferenceImages?: string;
    } & MarketplaceDraftFields);

/** 草稿字段不能安全提交时使用的客户端稳定错误。 */
export class ModelConfigurationDraftError extends Error {
  /**
   * 创建不包含文件内容或服务端细节的草稿错误。
   *
   * @param message - 可直接展示给管理员的简体中文说明。
   */
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationDraftError";
  }
}

/**
 * 把服务端有限价格转换为输入框文本。
 *
 * @param value - 已通过共享 DTO 校验的正有限积分。
 * @returns 不做本地化、可被保存解析器无损读取的十进制文本。
 * @sideEffects 无。
 * @failure DTO 类型边界保证输入合法，不抛错。
 */
function formatPricingValue(value: number): string {
  return String(value);
}

/**
 * 创建四档图像价格草稿。
 *
 * @param pricing - 已配置模型的四档价格；未配置模型传 null。
 * @returns 与输入对象隔离的字符串字段；未配置模型返回四个空输入。
 * @sideEffects 无。
 * @failure DTO 类型边界保证四档齐全，不抛错。
 */
function createImagePricingDraft(
  pricing:
    | Extract<
        ModelConfigurationEntry,
        { category: "image"; pricingSource: "explicit" }
      >["pricing"]
    | null
): ModelConfigurationImagePricingDraft {
  return {
    base1024Credits: pricing ? formatPricingValue(pricing.base1024Credits) : "",
    base1kCredits: pricing ? formatPricingValue(pricing.base1kCredits) : "",
    base2kCredits: pricing ? formatPricingValue(pricing.base2kCredits) : "",
    base4kCredits: pricing ? formatPricingValue(pricing.base4kCredits) : "",
  };
}

/**
 * 从管理 DTO 创建全新的编辑草稿。
 *
 * @param entry - 当前列表中被编辑的规范条目。
 * @param createRequestId - UUID 工厂；测试注入稳定值，浏览器默认使用 crypto.randomUUID。
 * @returns 与 DTO 隔离且封面默认为 keep 的草稿。
 * @sideEffects 默认工厂读取浏览器加密随机源一次。
 * @failure 运行时没有 crypto.randomUUID 时由平台显式抛错，不生成弱幂等键。
 */
export function createModelConfigurationDraft(
  entry: ModelConfigurationEntry,
  createRequestId: () => string = () => crypto.randomUUID()
): ModelConfigurationDraft {
  const common = {
    configKey: entry.configKey,
    expectedRevision: entry.revision,
    clientRequestId: createRequestId(),
  };
  const marketplace = {
    enabled: entry.enabled,
    visible: entry.visible,
    homepageVisible: entry.homepageVisible,
    homepagePriority: String(entry.homepagePriority),
    description: entry.description,
    cover: { action: "keep", file: null } as const,
  };
  if (entry.category === "image") {
    return {
      ...common,
      ...marketplace,
      category: "image",
      pricing: createImagePricingDraft(
        entry.pricingSource === "explicit" ? entry.pricing : null
      ),
    };
  }
  return {
    ...common,
    ...marketplace,
    category: "video",
    creditsPerSecondByResolution: Object.fromEntries(
      entry.supportedResolutions.map((resolution) => [
        resolution,
        formatPricingValue(entry.creditsPerSecondByResolution[resolution] ?? 0),
      ])
    ),
    ...(entry.maxReferenceImages !== undefined
      ? { maxReferenceImages: String(entry.maxReferenceImages) }
      : {}),
  };
}

/**
 * 为已修改草稿生成新的幂等键。
 *
 * 调用方先合并字段，再调用本函数；同一未修改草稿的网络重试不调用它，因此复用原 UUID。
 *
 * @param draft - 已合并用户修改的草稿。
 * @param createRequestId - UUID 工厂。
 * @returns 仅 clientRequestId 更新的新草稿。
 * @sideEffects 默认工厂读取浏览器加密随机源一次。
 * @failure UUID 合法性仍由服务端共享 schema 最终校验。
 */
export function renewModelConfigurationDraftRequestId<
  T extends ModelConfigurationDraft,
>(draft: T, createRequestId: () => string = () => crypto.randomUUID()): T {
  return { ...draft, clientRequestId: createRequestId() };
}

/**
 * revision 冲突后把本地编辑内容重放到最新条目版本。
 *
 * @param draft - 需要保留的未保存草稿。
 * @param latestEntry - 重新读取后的同一模型 DTO。
 * @param createRequestId - 下一次主动保存使用的新 UUID 工厂。
 * @returns 保留价格、展示与封面动作，只更新 revision 和幂等键的草稿。
 * @sideEffects 默认工厂读取浏览器加密随机源一次。
 * @failure 最新条目身份或类别不同则抛错，禁止把草稿串到其他模型。
 */
export function rebaseModelConfigurationDraft(
  draft: ModelConfigurationDraft,
  latestEntry: ModelConfigurationEntry,
  createRequestId: () => string = () => crypto.randomUUID()
): ModelConfigurationDraft {
  if (
    draft.category !== latestEntry.category ||
    draft.configKey !== latestEntry.configKey
  ) {
    throw new ModelConfigurationDraftError("无法把草稿合并到其他模型");
  }
  return {
    ...draft,
    expectedRevision: latestEntry.revision,
    clientRequestId: createRequestId(),
  };
}

/**
 * 严格解析价格输入框文本。
 *
 * @param value - 管理员输入的未本地化十进制文本。
 * @returns 正有限 number。
 * @sideEffects 无。
 * @failure 空值、指数、符号异常、零、负数或非有限值抛草稿错误。
 */
export function parseModelConfigurationPrice(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new ModelConfigurationDraftError("价格必须是有效的非负十进制数");
  }
  const price = Number(normalized);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ModelConfigurationDraftError("价格必须大于 0");
  }
  return price;
}

/**
 * 严格解析官网首页模型排序优先级。
 *
 * @param value - 管理员输入的整数文本。
 * @returns 0 到共享上限之间的整数，数字越小越优先。
 * @sideEffects 无。
 * @failure 空值、小数、负数、指数或超过上限时抛草稿错误。
 */
export function parseModelConfigurationHomepagePriority(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new ModelConfigurationDraftError("首页优先级必须是非负整数");
  }
  const priority = Number(normalized);
  if (
    !Number.isSafeInteger(priority) ||
    priority > MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY
  ) {
    throw new ModelConfigurationDraftError(
      `首页优先级不能超过 ${MAX_MODEL_MARKETPLACE_HOMEPAGE_PRIORITY}`
    );
  }
  return priority;
}

/**
 * 严格解析不设业务上限的正安全整数能力值。
 *
 * @param value - 管理员输入的十进制整数文本。
 * @returns 1 至 Number.MAX_SAFE_INTEGER 的整数。
 * @sideEffects 无。
 * @failure 空值、符号、小数、指数、零或超过安全整数时抛草稿错误。
 */
export function parseModelConfigurationPositiveSafeInteger(
  value: string
): number {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new ModelConfigurationDraftError("参考图上限必须是正整数");
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new ModelConfigurationDraftError("参考图上限超过安全整数范围");
  }
  return parsed;
}

/**
 * 把四档图像价格写入 multipart。
 *
 * @param formData - 当前保存请求的 FormData。
 * @param pricing - 四档字符串草稿。
 * @sideEffects 校验并向 FormData 追加四个规范数字字段。
 * @failure 任一价格不合法时抛草稿错误，不返回半成品给调用方。
 */
function appendImagePricing(
  formData: FormData,
  pricing: ModelConfigurationImagePricingDraft
): void {
  formData.append(
    "base1024Credits",
    String(parseModelConfigurationPrice(pricing.base1024Credits))
  );
  formData.append(
    "base1kCredits",
    String(parseModelConfigurationPrice(pricing.base1kCredits))
  );
  formData.append(
    "base2kCredits",
    String(parseModelConfigurationPrice(pricing.base2kCredits))
  );
  formData.append(
    "base4kCredits",
    String(parseModelConfigurationPrice(pricing.base4kCredits))
  );
}

/**
 * 把真实模型的展示字段和封面动作写入 multipart。
 *
 * @param formData - 当前保存请求的 FormData。
 * @param draft - 图像或视频草稿。
 * @sideEffects 追加展示字段；replace 时引用本地 File，不读取其字节。
 * @failure 简介超长、replace 文件为空或超过 5 MB 时抛草稿错误。
 */
function appendMarketplaceFields(
  formData: FormData,
  draft: Extract<ModelConfigurationDraft, { category: "image" | "video" }>
): void {
  if (
    draft.description.trim().length > MAX_MODEL_MARKETPLACE_DESCRIPTION_LENGTH
  ) {
    throw new ModelConfigurationDraftError("模型简介不能超过 200 个字符");
  }
  formData.append("enabled", String(draft.enabled));
  formData.append("visible", String(draft.visible));
  formData.append("homepageVisible", String(draft.homepageVisible));
  formData.append(
    "homepagePriority",
    String(parseModelConfigurationHomepagePriority(draft.homepagePriority))
  );
  formData.append("description", draft.description.trim());
  formData.append("coverChange", draft.cover.action);
  if (draft.cover.action !== "replace") return;
  if (
    draft.cover.file.size <= 0 ||
    draft.cover.file.size > MAX_MODEL_MARKETPLACE_COVER_BYTES
  ) {
    throw new ModelConfigurationDraftError("封面文件必须在 5 MB 以内");
  }
  formData.append("cover", draft.cover.file);
}

/**
 * 构造保存 Route 接受的严格 multipart 表单。
 *
 * @param draft - 当前已校验身份的编辑草稿。
 * @returns 只包含当前判别联合分支允许字段的 FormData。
 * @sideEffects 创建 FormData 并引用 replace 文件；不读取文件、不发网络请求。
 * @failure 价格、简介或封面无效时抛草稿错误，调用方应保留草稿并提示用户。
 */
export function buildModelConfigurationFormData(
  draft: ModelConfigurationDraft
): FormData {
  const formData = new FormData();
  formData.append("category", draft.category);
  formData.append("configKey", draft.configKey);
  formData.append("expectedRevision", String(draft.expectedRevision));
  formData.append("clientRequestId", draft.clientRequestId);

  appendMarketplaceFields(formData, draft);
  if (draft.category === "video") {
    const creditsPerSecondByResolution = Object.fromEntries(
      Object.entries(draft.creditsPerSecondByResolution)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([resolution, value]) => [
          resolution,
          parseModelConfigurationPrice(value),
        ])
    );
    formData.append(
      "creditsPerSecondByResolution",
      JSON.stringify(creditsPerSecondByResolution)
    );
    if (draft.maxReferenceImages !== undefined) {
      formData.append(
        "maxReferenceImages",
        String(
          parseModelConfigurationPositiveSafeInteger(draft.maxReferenceImages)
        )
      );
    }
    return formData;
  }
  appendImagePricing(formData, draft.pricing);
  return formData;
}
