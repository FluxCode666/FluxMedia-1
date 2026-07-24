/**
 * 图像生成分组模型目录的纯构建逻辑。
 *
 * 使用方：后端池服务将数据库中已授权的分组和健康成员收窄为创作页可安全展示的目录。
 * 关键依赖：共享的 API/Adobe 模型声明规范；本模块不访问数据库，便于覆盖默认回退和
 * 未声明模型清单等兼容边界。
 */
import { collectAdvertisedAdobeImageModelIds } from "@repo/shared/adobe/enabled-models";
import type { ImageCreditOverrides } from "@repo/shared/image-backend/group-image-pricing";
import {
  collectAdvertisedModelIds,
  normalizeSupportedModelIds,
} from "@repo/shared/image-backend/supported-models";

/** 页面是否应随请求发送分组 ID，隐式默认组沿用既有服务端回退解析。 */
export type ImageGenerationCatalogRoutingMode =
  | "implicit-default"
  | "explicit-selectable";

/** 单个模型可用的生成能力，不能以 UI 状态替代服务端再次校验。 */
export type ImageGenerationModelCapabilities = {
  generate: boolean;
  edit: boolean;
  mask: boolean;
};

/** 模型清单是否是成员明确列出的完整清单。 */
export type ImageGenerationModelListState = "declared" | "undeclared";

/** 返回给页面的一条模型目录项。 */
export type ImageGenerationCatalogModel = {
  id: string;
  capabilities: ImageGenerationModelCapabilities;
  modelListState: ImageGenerationModelListState;
};

/** 返回给页面的一条授权分组目录项。 */
export type ImageGenerationCatalogGroup = {
  id: string;
  name: string;
  isDefault: boolean;
  /** 当前目录分组的稀疏图像价格覆盖，仅用于页面预估，服务端仍重新解析计费。 */
  imageCreditOverrides?: ImageCreditOverrides;
  routingMode: ImageGenerationCatalogRoutingMode;
  models: ImageGenerationCatalogModel[];
};

/** 页面服务端加载的完整分组-模型目录。 */
export type ImageGenerationModelCatalog = {
  groups: ImageGenerationCatalogGroup[];
};

/** 图像账号实际使用的传输车道；未知值按 Web 的保守能力处理。 */
export type ImageGenerationCatalogAccountBackend = "web" | "responses";

/** 从数据库成员行提炼的无敏感信息模型能力来源。 */
export type ImageGenerationCatalogMember = {
  groupId: string;
  type: "account" | "adobe" | "api";
  /** 账号的图像能力由实现车道决定，不能复用其顶层对话模型。 */
  accountBackend?: ImageGenerationCatalogAccountBackend;
  /** 只有 Adobe 来源 API 可以实际承接 firefly-* 请求。 */
  adobeSourced?: boolean;
  defaultModel?: string | null;
  supportedModelIds?: unknown;
  enabledModels?: unknown;
  capabilities?: ImageGenerationModelCapabilities;
};

/** 纯目录构建器需要的已授权来源，不包含凭据、URL 或数据库实现细节。 */
export type ImageGenerationCatalogSource = {
  groups: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    imageCreditOverrides?: ImageCreditOverrides;
    routingMode: ImageGenerationCatalogRoutingMode;
  }>;
  members: ImageGenerationCatalogMember[];
};

type MutableCatalogModel = ImageGenerationCatalogModel & {
  normalizedId: string;
};

/** 后端池分组的目录展开所需公开字段。 */
export type ImageGenerationCatalogMemberGroup = {
  id: string;
  backendType: "mixed" | "web" | "responses";
  childGroupIds: readonly string[];
};

/** 成员健康信息，用于将目录可见性与调度器的可选语义保持一致。 */
export type ImageGenerationCatalogMemberAvailability = {
  isEnabled: boolean;
  alwaysActive: boolean;
  status: string;
  cooldownUntil?: Date | string | null;
};

const DEFAULT_IMAGE_MODEL_OPTION = "default";

/**
 * 构建成员归属到目录分组的映射。
 *
 * @param input.catalogGroupIds - 页面直接展示且允许选择或默认回退的分组。
 * @param input.groups - 已经通过启用状态和套餐校验的全部候选分组。
 * @returns 以成员实际归属分组为键、以页面目录分组为值的映射。
 * @remarks mixed 父组只展开一层有效的非 mixed 子组，严格贴合调度器的上下文展开规则。
 */
export function buildImageGenerationCatalogMemberGroupMap(input: {
  catalogGroupIds: readonly string[];
  groups: readonly ImageGenerationCatalogMemberGroup[];
}): Map<string, string[]> {
  const groupsById = new Map(input.groups.map((group) => [group.id, group]));
  const catalogGroupIdsByMemberGroupId = new Map<string, Set<string>>();
  const addMembership = (memberGroupId: string, catalogGroupId: string) => {
    const catalogGroupIds =
      catalogGroupIdsByMemberGroupId.get(memberGroupId) || new Set<string>();
    catalogGroupIds.add(catalogGroupId);
    catalogGroupIdsByMemberGroupId.set(memberGroupId, catalogGroupIds);
  };

  for (const catalogGroupId of input.catalogGroupIds) {
    const group = groupsById.get(catalogGroupId);
    if (!group) continue;
    addMembership(group.id, group.id);
    if (group.backendType !== "mixed") continue;

    for (const childGroupId of group.childGroupIds) {
      const childGroup = groupsById.get(childGroupId);
      // WHY: 调度器只接受已启用、套餐可用的一层非 mixed 子组；调用方传入的 groups
      // 已完成前两项过滤，这里保留后两项以防数据库历史配置绕过管理端校验。
      if (
        !childGroup ||
        childGroup.backendType === "mixed" ||
        childGroup.childGroupIds.length > 0
      ) {
        continue;
      }
      addMembership(childGroup.id, group.id);
    }
  }

  return new Map(
    Array.from(catalogGroupIdsByMemberGroupId, ([groupId, catalogGroupIds]) => [
      groupId,
      Array.from(catalogGroupIds),
    ])
  );
}

/**
 * 判断一个成员在当前时刻是否会进入图像调度候选集。
 *
 * @param member - 成员的启用、常驻、状态和冷却信息。
 * @param now - 用于比较冷却的当前时间，测试可注入固定时钟。
 * @returns 成员能被正常调度时返回 true。
 * @remarks alwaysActive 与调度器一致：仍排除终态 error，但忽略暂时的 cooldown。
 */
export function isImageGenerationCatalogMemberAvailable(
  member: ImageGenerationCatalogMemberAvailability,
  now = new Date()
): boolean {
  if (!member.isEnabled || member.status === "error") return false;
  if (member.alwaysActive) return true;

  const cooldownUntil = member.cooldownUntil;
  const cooldownExpiresAt = cooldownUntil
    ? new Date(cooldownUntil).getTime()
    : Number.NaN;
  const cooldownExpired =
    Number.isFinite(cooldownExpiresAt) && cooldownExpiresAt <= now.getTime();
  if (member.status === "active") {
    return !cooldownUntil || cooldownExpired;
  }
  // limited 状态必须存在且已过期的冷却时间；NULL 不能被当成恢复可用。
  return member.status === "limited" && cooldownExpired;
}

/** 返回成员未提供明确能力时的保守默认能力。 */
function getDefaultCapabilities(
  member: ImageGenerationCatalogMember
): ImageGenerationModelCapabilities {
  if (member.type === "adobe") {
    return { generate: true, edit: true, mask: false };
  }
  if (member.type === "account") {
    return {
      generate: true,
      edit: true,
      // Web 编辑适配器不发送 mask；未知账号车道同样按 Web 保守处理。
      mask: member.accountBackend === "responses",
    };
  }
  return { generate: true, edit: true, mask: true };
}

/**
 * 收窄成员能力到其传输适配器真实能承接的边界。
 *
 * @param member - 目录成员来源。
 * @returns 不能被成员实际下传的能力已强制关闭的能力对象。
 */
function getMemberCapabilities(
  member: ImageGenerationCatalogMember
): ImageGenerationModelCapabilities {
  const capabilities = member.capabilities || getDefaultCapabilities(member);
  if (member.type === "adobe") {
    return { ...capabilities, mask: false };
  }
  if (member.type === "account" && member.accountBackend !== "responses") {
    return { ...capabilities, mask: false };
  }
  return capabilities;
}

/** 规范化可展示模型 ID，防止配置中的空值占据目录。 */
function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const modelId = value.trim();
  return modelId ? modelId : null;
}

/** 判断 API 成员是否未声明完整模型清单，空数组保留历史不限调度语义。 */
function hasUndeclaredApiModelList(member: ImageGenerationCatalogMember) {
  return normalizeSupportedModelIds(member.supportedModelIds).length === 0;
}

/** 判断模型是否属于仅 Adobe 来源成员可服务的 Firefly 路由。 */
function isFireflyModelId(modelId: string) {
  return modelId.trim().toLowerCase().startsWith("firefly-");
}

/** 过滤普通 API 不会被调度器选中的 Firefly 模型声明。 */
function filterApiModelIds(
  modelIds: string[],
  member: ImageGenerationCatalogMember
) {
  return member.adobeSourced
    ? modelIds
    : modelIds.filter((modelId) => !isFireflyModelId(modelId));
}

/** 将一个成员可诚实展示的模型转换为目录状态。 */
function getMemberModels(member: ImageGenerationCatalogMember): Array<{
  id: string;
  modelListState: ImageGenerationModelListState;
}> {
  if (member.type === "adobe") {
    return collectAdvertisedAdobeImageModelIds([
      { enabledModels: member.enabledModels },
    ]).map((id) => ({ id, modelListState: "declared" as const }));
  }

  if (member.type === "api") {
    const modelListState = hasUndeclaredApiModelList(member)
      ? "undeclared"
      : "declared";
    const modelIds = filterApiModelIds(
      collectAdvertisedModelIds([
        {
          model: member.defaultModel,
          supportedModelIds: member.supportedModelIds,
        },
      ]),
      member
    );
    if (modelIds.length) {
      return modelIds.map((id) => ({ id, modelListState }));
    }

    // 明确模型列表只含普通 API 无法承接的 Firefly 模型时，不用默认模型掩盖该错误。
    if (modelListState === "declared") return [];

    const fallbackModel =
      normalizeModelId(member.defaultModel) || DEFAULT_IMAGE_MODEL_OPTION;
    if (!member.adobeSourced && isFireflyModelId(fallbackModel)) return [];
    return [{ id: fallbackModel, modelListState }];
  }

  return [
    {
      // account.model 是 Web/Responses 顶层对话模型，不是可传给图片接口的模型。
      id: DEFAULT_IMAGE_MODEL_OPTION,
      modelListState: "undeclared",
    },
  ];
}

/** 合并同一模型的成员能力，让任一真实可用成员决定可用能力。 */
function mergeCapabilities(
  current: ImageGenerationModelCapabilities,
  next: ImageGenerationModelCapabilities
): ImageGenerationModelCapabilities {
  return {
    generate: current.generate || next.generate,
    edit: current.edit || next.edit,
    mask: current.mask || next.mask,
  };
}

/**
 * 按授权分组构建页面模型目录。
 *
 * @param source - 已由服务端过滤过套餐、启用状态和分组选择资格的公开数据。
 * @returns 无凭据、可直接序列化到 Server Component 的分组模型目录。
 * @remarks 空 API 模型清单只提供默认模型和兼容状态，不虚构完整可选模型列表。
 */
export function buildImageGenerationModelCatalog(
  source: ImageGenerationCatalogSource
): ImageGenerationModelCatalog {
  const membersByGroupId = new Map<string, ImageGenerationCatalogMember[]>();
  for (const member of source.members) {
    const current = membersByGroupId.get(member.groupId) || [];
    current.push(member);
    membersByGroupId.set(member.groupId, current);
  }

  return {
    groups: source.groups.map((group) => {
      const modelsById = new Map<string, MutableCatalogModel>();
      for (const member of membersByGroupId.get(group.id) || []) {
        const capabilities = getMemberCapabilities(member);
        for (const model of getMemberModels(member)) {
          const normalizedId = model.id.toLowerCase();
          const existing = modelsById.get(normalizedId);
          if (existing) {
            existing.capabilities = mergeCapabilities(
              existing.capabilities,
              capabilities
            );
            if (model.modelListState === "undeclared") {
              existing.modelListState = "undeclared";
            }
            continue;
          }
          modelsById.set(normalizedId, {
            id: model.id,
            normalizedId,
            capabilities: { ...capabilities },
            modelListState: model.modelListState,
          });
        }
      }

      return {
        id: group.id,
        name: group.name,
        isDefault: group.isDefault,
        ...(group.imageCreditOverrides
          ? { imageCreditOverrides: group.imageCreditOverrides }
          : {}),
        routingMode: group.routingMode,
        models: Array.from(modelsById.values()).map(
          ({ normalizedId: _normalizedId, ...model }) => model
        ),
      };
    }),
  };
}
