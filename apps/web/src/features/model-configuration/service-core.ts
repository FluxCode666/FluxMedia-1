/**
 * 模型配置的 DB-free 保存状态机。
 *
 * 使用方是后续 Drizzle 仓储与 UOL binding。本模块通过可注入事务、目录、对象存储、
 * 封面处理、审计、缓存、时钟和哈希端口保证单条目乐观锁、幂等重放与引用安全清理，
 * 自身不导入数据库或具体存储 Provider。
 */

import {
  getVideoPricingResolutionKey,
  globalVideoModelCreditsPerSecondSchema,
} from "@repo/shared/adobe";
import {
  type GlobalImageCreditOverrides,
  globalImageCreditOverridesSchema,
  normalizeImagePricingModelId,
} from "@repo/shared/image-backend/group-image-pricing";
import {
  type ModelConfigurationSnapshot,
  modelMarketplaceCustomModelSchema,
  type ModelMarketplaceConfig,
  type ModelMarketplaceConfigurationCategory,
  type ModelMarketplaceCoverRef,
  type ModelMarketplaceWriteReceipt,
  modelConfigurationSnapshotSchema,
  modelMarketplaceConfigSchema,
  modelMarketplaceImagePricingSchema,
  parseModelMarketplaceConfig,
  pruneModelMarketplaceWriteReceipts,
  resolveModelMarketplaceEntry,
  type UpdateModelConfigurationEntryInput,
  type UpdateModelConfigurationEntryOutput,
  updateModelConfigurationEntryInputSchema,
  updateModelConfigurationEntryOutputSchema,
} from "@repo/shared/model-marketplace";
import {
  parseVideoModelCapabilityOverrides,
  type VideoModelCapabilityOverrides,
  videoModelCapabilityOverridesSchema,
} from "@repo/shared/video-generation";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/** 保存内核可稳定映射到 UOL 的领域错误码。 */
export type ModelConfigurationServiceErrorCode =
  | "not_configurable"
  | "revision_conflict"
  | "idempotency_conflict"
  | "revision_exhausted"
  | "invalid_dependency_result";

/** 带稳定错误码且不泄漏底层凭据或原始异常的保存领域错误。 */
export class ModelConfigurationServiceError extends Error {
  /**
   * 创建模型配置领域错误。
   *
   * @param code - 供 UOL 映射的稳定错误码。
   * @param message - 可安全呈现给管理端的简体中文消息。
   */
  constructor(
    readonly code: ModelConfigurationServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ModelConfigurationServiceError";
  }
}

/** 数据库事务内可用的锁定读写能力；具体实现负责初始化缺失设置行。 */
export interface ModelConfigurationTransaction {
  /** 供审计端口绑定同一底层事务的透明上下文。 */
  readonly auditContext: unknown;
  /** 初始化并锁定模型广场配置行，必须先于任一价格行调用。 */
  lockMarketplaceConfig(): Promise<unknown>;
  /** 初始化并锁定完整图像价格行。 */
  lockImagePricing(): Promise<unknown>;
  /** 初始化并锁定完整视频价格行。 */
  lockVideoPricing(): Promise<unknown>;
  /** 初始化并锁定视频能力覆盖行；必须晚于视频价格行。 */
  lockVideoCapabilities(): Promise<unknown>;
  /** 保存已通过严格 schema 的展示配置及幂等回执。 */
  saveMarketplaceConfig(
    config: ModelMarketplaceConfig,
    actorUserId: string
  ): Promise<void>;
  /** 保存已通过全局财务 schema 的完整图像价格矩阵。 */
  saveImagePricing(
    pricing: GlobalImageCreditOverrides,
    actorUserId: string
  ): Promise<void>;
  /** 保存已通过全局财务 schema 的完整视频价格矩阵。 */
  saveVideoPricing(
    pricing: Record<string, number>,
    actorUserId: string
  ): Promise<void>;
  /** 保存已通过严格 schema 的完整视频能力覆盖。 */
  saveVideoCapabilities(
    capabilities: VideoModelCapabilityOverrides,
    actorUserId: string
  ): Promise<void>;
}

/** 只开启一层底层事务的模型配置仓储端口。 */
export interface ModelConfigurationRepository {
  /**
   * 在一次原子事务中执行工作。
   *
   * @param work - 使用锁定配置和价格行的事务回调。
   * @returns 回调结果；回调或提交失败时不得保留任何数据库写入。
   */
  transaction<T>(
    work: (transaction: ModelConfigurationTransaction) => Promise<T>
  ): Promise<T>;
}

/** 对象存储读取结果；明确区分不存在与基础设施失败。 */
export type ModelConfigurationStorageReadResult =
  | { status: "found"; bytes: Uint8Array }
  | { status: "not_found" };

/** 模型封面的服务端对象存储端口。 */
export interface ModelConfigurationStoragePort {
  /** 写入已经安全处理的不可变 WebP 内容。 */
  putObject(
    reference: ModelMarketplaceCoverRef,
    bytes: Uint8Array,
    contentType: "image/webp"
  ): Promise<void>;
  /** 预检旧引用是否可读取；基础设施错误必须拒绝 remove。 */
  getObject(
    reference: ModelMarketplaceCoverRef
  ): Promise<ModelConfigurationStorageReadResult>;
  /** 删除已在配置锁内确认无引用的对象。 */
  deleteObject(reference: ModelMarketplaceCoverRef): Promise<void>;
}

/** 延迟加载由唯一管理目录构建器生成的严格快照。 */
export interface ModelConfigurationCatalogLoader {
  /**
   * 返回本次保存使用的稳定管理快照。
   *
   * production service 应直接复用 read-service/catalog 的装配结果，不能另写一套模型
   * 白名单；加载失败时显式上抛，不能套用公开目录的 not_ready 策略。
   */
  load(): Promise<ModelConfigurationSnapshot>;
}

/** 安全封面处理器的输出，只包含服务端可信 WebP 事实。 */
export interface ProcessedModelConfigurationCover {
  bytes: Uint8Array;
  sha256: string;
  contentType: "image/webp";
}

/** Sharp 封面处理模块的最小注入端口。 */
export interface ModelConfigurationCoverImageProcessor {
  /**
   * 解码并规范化不可信图片字节。
   *
   * @param bytes - 已通过共享输入大小上限的原始文件字节。
   * @returns 去元数据、3:2 且内容哈希已计算的静态 WebP。
   * @throws 图片非法或处理失败时显式上抛，调用方此时不会触达存储。
   */
  process(bytes: Uint8Array): Promise<ProcessedModelConfigurationCover>;
}

/** 原子写入管理审计表的稳定事件，不含图片字节、凭据或原始异常。 */
export interface ModelConfigurationAuditEvent {
  id: string;
  actorUserId: string;
  action: "model_configuration.update";
  category: ModelMarketplaceConfigurationCategory;
  configKey: string;
  previousRevision: number;
  resultingRevision: number;
  coverAction: "keep" | "remove" | "replace";
  occurredAt: string;
}

/** 使用仓储透明事务上下文写入审计的端口。 */
export interface ModelConfigurationAuditPort {
  /** 在配置和价格所在的同一事务中写一次审计事件。 */
  record(context: unknown, event: ModelConfigurationAuditEvent): Promise<void>;
}

/** 提交后系统设置缓存失效端口。 */
export interface ModelConfigurationCachePort {
  /** 失效展示与价格设置缓存；失败只告警，数据库仍是真相。 */
  invalidate(): Promise<void>;
}

/** 不携带原始异常的结构化告警字段。 */
export interface ModelConfigurationWarning {
  event:
    | "model_configuration_cache_invalidation_failed"
    | "model_configuration_cover_cleanup_failed";
  category: ModelMarketplaceConfigurationCategory;
  configKey: string;
  cleanupReason?: "transaction_failed" | "replaced" | "removed";
  bucket?: string;
  key?: string;
}

/** 保存内核日志端口。 */
export interface ModelConfigurationLoggerPort {
  /** 记录稳定结构化字段，调用方不得附带 Error 对象或存储凭据。 */
  warn(fields: ModelConfigurationWarning): void;
}

/** 可测试时钟端口。 */
export interface ModelConfigurationClockPort {
  /** 返回当前绝对时间；非法 Date 会被拒绝。 */
  now(): Date;
}

/** SHA-256 端口，用于回执键、载荷哈希和安全对象路径。 */
export interface ModelConfigurationHashPort {
  /** 对稳定字符串或字节计算小写 64 位十六进制 SHA-256。 */
  sha256(value: string | Uint8Array): Promise<string>;
}

/** 审计记录 ID 工厂端口。 */
export interface ModelConfigurationIdPort {
  /** 创建不包含用户输入的唯一审计 ID。 */
  create(): string;
}

/** 创建模型配置保存服务所需的全部可注入依赖。 */
export interface ModelConfigurationServiceDependencies {
  repository: ModelConfigurationRepository;
  storage: ModelConfigurationStoragePort;
  catalogLoader: ModelConfigurationCatalogLoader;
  coverImageProcessor: ModelConfigurationCoverImageProcessor;
  cache: ModelConfigurationCachePort;
  audit: ModelConfigurationAuditPort;
  logger: ModelConfigurationLoggerPort;
  clock: ModelConfigurationClockPort;
  hash: ModelConfigurationHashPort;
  ids: ModelConfigurationIdPort;
  assetBucket: string;
}

/** 保存服务的单一公开写入口。 */
export interface ModelConfigurationService {
  /**
   * 保存一个真实模型的价格与展示配置。
   *
   * @param command.actorUserId - 真实超级管理员用户 ID，用于审计和用户级回执键。
   * @param command.input - 未信任 UOL 输入，由共享严格联合 schema 收窄。
   * @returns 最小保存结果；客户端应重新读取管理快照。
   * @throws 输入、目录、revision、幂等、存储或事务失败时显式上抛。
   */
  updateEntry(command: {
    actorUserId: string;
    input: unknown;
  }): Promise<UpdateModelConfigurationEntryOutput>;
}

interface PreparedCoverReplacement {
  reference: ModelMarketplaceCoverRef;
  bytes: Uint8Array;
  contentHash: string;
  contentType: "image/webp";
}

interface TransactionSaveResult {
  output: UpdateModelConfigurationEntryOutput;
  replayed: boolean;
  oldCover: ModelMarketplaceCoverRef | null;
}

/**
 * 判断两个可选封面引用是否指向相同内容寻址对象。
 *
 * @param left - 第一个封面引用或默认封面空值。
 * @param right - 第二个封面引用或默认封面空值。
 * @returns bucket 与 key 均相等时返回 true；两个 null 不代表对象引用，返回 false。
 */
function coversEqual(
  left: ModelMarketplaceCoverRef | null,
  right: ModelMarketplaceCoverRef | null
): boolean {
  return left?.bucket === right?.bucket && left?.key === right?.key;
}

/**
 * 校验依赖端口返回的值确实是规范小写 SHA-256。
 *
 * @param value - 外部哈希或封面处理端口返回的文本。
 * @param source - 可安全出现在领域错误中的端口名称。
 * @returns 已验证的 SHA-256 文本。
 * @throws 端口违反返回契约时抛出 invalid_dependency_result。
 */
function assertSha256(value: string, source: string): string {
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      `${source}未返回有效的 SHA-256`
    );
  }
  return value;
}

/**
 * 把输入模型键规范化为保存和回执使用的唯一键。
 *
 * @param input - 已通过共享联合 schema 的保存输入。
 * @returns 保留联合分支且 configKey 已规范化的新输入。
 * @throws 图像键规范化为空时抛出 not_configurable。
 */
function normalizeConfigurationInput(
  input: UpdateModelConfigurationEntryInput
): UpdateModelConfigurationEntryInput {
  const normalized =
    input.isCustom === true
      ? input.configKey.trim().toLowerCase()
      : input.category === "image"
        ? normalizeImagePricingModelId(input.configKey)
        : input.configKey.trim().toLowerCase();
  if (!normalized) {
    throw new ModelConfigurationServiceError(
      "not_configurable",
      "模型配置键无效"
    );
  }
  return { ...input, configKey: normalized };
}

/**
 * 安全递增非负 revision，避免超过 JavaScript 安全整数后失去并发语义。
 *
 * @param revision - 当前已严格解析的非负安全整数。
 * @returns 加一后的 revision。
 * @throws 当前值已到安全整数上限时抛出 revision_exhausted。
 */
function incrementRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new ModelConfigurationServiceError(
      "revision_exhausted",
      "模型配置修订号已达到上限"
    );
  }
  return revision + 1;
}

/**
 * 返回输入指定的封面动作。
 *
 * @param input - 规范保存输入。
 * @returns 审计使用的封面动作。
 */
function getCoverAction(
  input: UpdateModelConfigurationEntryInput
): ModelConfigurationAuditEvent["coverAction"] {
  return input.coverChange.action;
}

/**
 * 构造不含 clientRequestId 和原始图片字节的稳定载荷 JSON。
 *
 * @param input - 规范保存输入，字段按固定顺序投影。
 * @param replacementContentHash - replace 的最终 WebP 内容哈希，其余动作传 null。
 * @returns 用于 requestHash 的确定性 JSON 文本。
 */
function serializeRequestPayload(
  input: UpdateModelConfigurationEntryInput,
  replacementContentHash: string | null
): string {
  const common = {
    category: input.category,
    configKey: input.configKey,
    expectedRevision: input.expectedRevision,
    ...(input.isCustom ? { isCustom: true } : {}),
    visible: input.visible,
    homepageVisible: input.homepageVisible,
    homepagePriority: input.homepagePriority,
    description: input.description,
    coverChange:
      input.coverChange.action === "replace"
        ? { action: "replace", contentHash: replacementContentHash }
        : { action: input.coverChange.action },
  };
  if (input.category === "video") {
    return JSON.stringify({
      ...common,
      creditsPerSecondByResolution: Object.fromEntries(
        Object.entries(input.creditsPerSecondByResolution).sort(
          ([left], [right]) => left.localeCompare(right)
        )
      ),
      ...(input.maxReferenceImages !== undefined
        ? { maxReferenceImages: input.maxReferenceImages }
        : {}),
    });
  }
  return JSON.stringify({
    ...common,
    ...(input.supportedResolutions
      ? { supportedResolutions: input.supportedResolutions }
      : {}),
    pricing: input.pricing,
  });
}

/**
 * 判断任一图像或视频条目是否仍引用给定封面对象。
 *
 * @param config - 清理短事务内锁定并严格解析的完整展示配置。
 * @param reference - 待清理的内容寻址对象。
 * @returns 任一类别仍引用对象时返回 true。
 */
function isCoverReferenced(
  config: ModelMarketplaceConfig,
  reference: ModelMarketplaceCoverRef
): boolean {
  return [
    ...Object.values(config.imageByModel),
    ...Object.values(config.videoByFamily),
  ].some((entry) => coversEqual(entry.cover, reference));
}

/**
 * 校验单个持久化封面引用只能属于专用模型资产桶。
 *
 * production 的管理读取 `buildCoverUrl` 必须在构造第一方 URL 前复用此边界；保存与清理
 * 则通过完整配置校验间接调用，避免脏 JSON 触达 avatars 或 generations。
 *
 * @param reference - 严格解析后的持久化封面引用，null 代表使用本地默认封面。
 * @param assetBucket - 运行时已与 avatars/generations 交叉验证的模型资产桶。
 * @returns 无返回；合法引用不产生副作用。
 * @throws 桶为空或引用跨桶时抛出 invalid_dependency_result。
 */
export function assertModelConfigurationCoverBucket(
  reference: ModelMarketplaceCoverRef | null,
  assetBucket: string
): void {
  const normalizedAssetBucket = assetBucket.trim();
  if (
    !normalizedAssetBucket ||
    (reference !== null && reference.bucket !== normalizedAssetBucket)
  ) {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "模型封面配置包含非法存储桶引用"
    );
  }
}

/**
 * 拒绝展示配置中跨桶的历史脏引用。
 *
 * 该校验必须先于 get、put 或 delete；否则被篡改的持久化 JSON 可能让模型资产流程触达
 * avatars 或 generations 等其他安全域。配置脏值不会被默认值静默覆盖。
 *
 * @param config - 当前事务锁定并严格解析的展示配置。
 * @param assetBucket - 运行时已交叉验证的专用模型资产桶。
 * @returns 无返回；只执行 fail-closed 校验，不写配置或存储。
 * @throws 任一现存引用跨桶时抛出 invalid_dependency_result。
 */
function assertCoverBuckets(
  config: ModelMarketplaceConfig,
  assetBucket: string
): void {
  const entries = [
    ...Object.values(config.imageByModel),
    ...Object.values(config.videoByFamily),
  ];
  for (const entry of entries) {
    assertModelConfigurationCoverBucket(entry.cover, assetBucket);
  }
}

/**
 * 创建只依赖注入端口的模型配置保存服务。
 *
 * @param dependencies - 事务、存储、目录、安全图片处理和基础设施端口。
 * @returns 可供 UOL late binding 调用的单条目保存服务。
 */
export function createModelConfigurationService(
  dependencies: ModelConfigurationServiceDependencies
): ModelConfigurationService {
  const assetBucket = dependencies.assetBucket.trim();
  if (!assetBucket) {
    throw new ModelConfigurationServiceError(
      "invalid_dependency_result",
      "模型资产存储桶未配置"
    );
  }

  /**
   * 返回有效注入时间，防止非法时钟破坏回执保留窗口。
   *
   * @returns 可用于 ISO 时间戳与 24 小时回执裁剪的 Date。
   * @throws 时钟返回非法 Date 时抛出 invalid_dependency_result。
   */
  function getNow(): Date {
    const now = dependencies.clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new ModelConfigurationServiceError(
        "invalid_dependency_result",
        "模型配置时钟无效"
      );
    }
    return now;
  }

  /**
   * 在短事务内重新锁定配置并复核全局引用，然后保持锁执行对象删除。
   *
   * @param reference - 可能已成为孤儿的内容寻址对象。
   * @param input - 用于稳定告警字段的保存输入。
   * @param reason - 新对象补偿、替换旧对象或主动移除。
   * @returns 无返回；删除或清理事务失败只记录告警。
   */
  async function cleanupCoverIfUnreferenced(
    reference: ModelMarketplaceCoverRef,
    input: UpdateModelConfigurationEntryInput,
    reason: "transaction_failed" | "replaced" | "removed"
  ): Promise<void> {
    try {
      await dependencies.repository.transaction(async (transaction) => {
        const config = parseModelMarketplaceConfig(
          await transaction.lockMarketplaceConfig()
        );
        assertCoverBuckets(config, assetBucket);
        if (isCoverReferenced(config, reference)) return;
        await dependencies.storage.deleteObject(reference);
      });
    } catch {
      dependencies.logger.warn({
        event: "model_configuration_cover_cleanup_failed",
        category: input.category,
        configKey: input.configKey,
        cleanupReason: reason,
        bucket: reference.bucket,
        key: reference.key,
      });
    }
  }

  /**
   * 处理 replace 字节并构造不含原模型 ID 的内容寻址对象引用。
   *
   * @param input - 已验证目录成员的规范保存输入。
   * @returns replace 的可信 WebP 与对象引用；keep、remove 返回 null。
   * @throws 图片解码或哈希端口失败时显式上抛，且不会写对象存储。
   */
  async function prepareCoverReplacement(
    input: UpdateModelConfigurationEntryInput
  ): Promise<PreparedCoverReplacement | null> {
    if (input.coverChange.action !== "replace") {
      return null;
    }
    const processed = await dependencies.coverImageProcessor.process(
      input.coverChange.bytes
    );
    const contentHash = assertSha256(
      processed.sha256.toLowerCase(),
      "封面处理器"
    );
    const configHash = assertSha256(
      (await dependencies.hash.sha256(input.configKey)).toLowerCase(),
      "哈希端口"
    );
    return {
      reference: {
        bucket: assetBucket,
        key: `${input.category}/${configHash}/${contentHash}.webp`,
      },
      bytes: processed.bytes,
      contentHash,
      contentType: processed.contentType,
    };
  }

  return {
    async updateEntry(command) {
      const actorUserId = command.actorUserId.trim();
      if (!actorUserId || actorUserId.length > 255) {
        throw new ModelConfigurationServiceError(
          "invalid_dependency_result",
          "管理员用户标识无效"
        );
      }
      const input = normalizeConfigurationInput(
        updateModelConfigurationEntryInputSchema.parse(command.input)
      );
      const catalog = modelConfigurationSnapshotSchema.parse(
        await dependencies.catalogLoader.load()
      );
      const catalogEntry = catalog.entries.find(
        (entry) =>
          entry.category === input.category &&
          entry.configKey === input.configKey
      );
      const isCustomCreate = input.isCustom === true;
      const customCreateCatalogConflict = catalog.entries.some(
        (entry) =>
          entry.configKey.trim().toLowerCase() === input.configKey.toLowerCase()
      );
      if (!catalogEntry && !isCustomCreate) {
        throw new ModelConfigurationServiceError(
          "not_configurable",
          "模型不在当前可配置清单中"
        );
      }
      if (isCustomCreate) {
        if (input.expectedRevision !== 0) {
          throw new ModelConfigurationServiceError(
            "not_configurable",
            "自定义模型 ID 已存在或修订号无效"
          );
        }
        if (input.category === "image") {
          if (
            !input.supportedResolutions ||
            input.supportedResolutions.length === 0
          ) {
            throw new ModelConfigurationServiceError(
              "not_configurable",
              "自定义图像模型至少需要一个支持的分辨率"
            );
          }
          modelMarketplaceCustomModelSchema.parse({
            modelId: input.configKey,
            category: input.category,
            supportedResolutions: input.supportedResolutions,
          });
        }
      }
      if (input.category === "video" && catalogEntry?.category === "video") {
        const expectedResolutions = [
          ...catalogEntry.supportedResolutions,
        ].sort();
        const submittedResolutions = Object.keys(
          input.creditsPerSecondByResolution
        ).sort();
        if (
          expectedResolutions.length !== submittedResolutions.length ||
          expectedResolutions.some(
            (resolution, index) => resolution !== submittedResolutions[index]
          )
        ) {
          throw new ModelConfigurationServiceError(
            "not_configurable",
            "视频分辨率价格与当前模型目录不一致"
          );
        }
        const capabilityIsConfigurable =
          catalogEntry.maxReferenceImages !== undefined;
        if (
          capabilityIsConfigurable !==
          (input.maxReferenceImages !== undefined)
        ) {
          throw new ModelConfigurationServiceError(
            "not_configurable",
            capabilityIsConfigurable
              ? "该视频模型必须提交参考图上限"
              : "该视频模型不允许配置参考图上限"
          );
        }
      }

      const replacement = await prepareCoverReplacement(input);
      const receiptKey = assertSha256(
        (
          await dependencies.hash.sha256(
            JSON.stringify([actorUserId, input.clientRequestId])
          )
        ).toLowerCase(),
        "哈希端口"
      );
      const requestHash = assertSha256(
        (
          await dependencies.hash.sha256(
            serializeRequestPayload(input, replacement?.contentHash ?? null)
          )
        ).toLowerCase(),
        "哈希端口"
      );
      const now = getNow();
      let newObjectWritten = false;
      let transactionResult: TransactionSaveResult;

      try {
        transactionResult = await dependencies.repository.transaction(
          async (transaction) => {
            const config = parseModelMarketplaceConfig(
              await transaction.lockMarketplaceConfig()
            );
            assertCoverBuckets(config, assetBucket);
            const imagePricing =
              input.category === "image"
                ? globalImageCreditOverridesSchema.parse(
                    await transaction.lockImagePricing()
                  )
                : null;
            const videoPricing =
              input.category === "video"
                ? globalVideoModelCreditsPerSecondSchema.parse(
                    await transaction.lockVideoPricing()
                  )
                : null;
            const videoCapabilities =
              input.category === "video"
                ? parseVideoModelCapabilityOverrides(
                    await transaction.lockVideoCapabilities()
                  )
                : null;

            const existingReceipt = config.writeReceipts[receiptKey];
            if (existingReceipt) {
              if (existingReceipt.requestHash !== requestHash) {
                throw new ModelConfigurationServiceError(
                  "idempotency_conflict",
                  "该请求标识已用于另一份模型配置"
                );
              }
              return {
                output: updateModelConfigurationEntryOutputSchema.parse({
                  category: existingReceipt.category,
                  configKey: existingReceipt.configKey,
                  revision: existingReceipt.resultingRevision,
                }),
                replayed: true,
                oldCover: null,
              };
            }

            const currentEntry =
              input.category === "image"
                ? resolveModelMarketplaceEntry(
                    config.imageByModel[input.configKey],
                    "image"
                  )
                : resolveModelMarketplaceEntry(
                    config.videoByFamily[input.configKey],
                    "video"
                  );
            if (isCustomCreate) {
              const customModel = modelMarketplaceCustomModelSchema.parse({
                modelId: input.configKey,
                category: input.category,
                supportedResolutions:
                  input.category === "image"
                    ? input.supportedResolutions
                    : Object.keys(input.creditsPerSecondByResolution),
              });
              const hasCustomModel = config.customModels.some(
                (model) =>
                  model.modelId.trim().toLowerCase() ===
                  customModel.modelId.trim().toLowerCase()
              );
              if (hasCustomModel || customCreateCatalogConflict) {
                throw new ModelConfigurationServiceError(
                  "not_configurable",
                  "自定义模型 ID 已存在"
                );
              }
              config.customModels.push(customModel);
            }
            const currentRevision = currentEntry.revision;
            if (currentRevision !== input.expectedRevision) {
              throw new ModelConfigurationServiceError(
                "revision_conflict",
                "模型配置已被其他管理员更新"
              );
            }
            const resultingRevision = incrementRevision(currentRevision);
            const oldCover = currentEntry.cover;
            if (input.coverChange.action === "remove" && oldCover) {
              await dependencies.storage.getObject(oldCover);
            }
            if (replacement) {
              await dependencies.storage.putObject(
                replacement.reference,
                replacement.bytes,
                replacement.contentType
              );
              newObjectWritten = true;
            }

            const nextConfig: ModelMarketplaceConfig = structuredClone(config);
            const nextCover =
              input.coverChange.action === "keep"
                ? oldCover
                : input.coverChange.action === "remove"
                  ? null
                  : (replacement?.reference ?? null);
            const nextEntry = {
              revision: resultingRevision,
              visible: input.visible,
              homepageVisible: input.homepageVisible,
              homepagePriority: input.homepagePriority,
              description: input.description,
              cover: nextCover,
            };
            if (input.category === "image") {
              if (!imagePricing) {
                throw new ModelConfigurationServiceError(
                  "invalid_dependency_result",
                  "图像价格事务未初始化"
                );
              }
              const nextImagePricing = globalImageCreditOverridesSchema.parse({
                ...imagePricing,
                byModel: {
                  ...imagePricing.byModel,
                  [input.configKey]: modelMarketplaceImagePricingSchema.parse(
                    input.pricing
                  ),
                },
              });
              nextConfig.imageByModel[input.configKey] = nextEntry;
              await transaction.saveImagePricing(nextImagePricing, actorUserId);
            } else {
              if (!videoPricing) {
                throw new ModelConfigurationServiceError(
                  "invalid_dependency_result",
                  "视频价格事务未初始化"
                );
              }
              if (!videoCapabilities) {
                throw new ModelConfigurationServiceError(
                  "invalid_dependency_result",
                  "视频能力事务未初始化"
                );
              }
              const nextVideoPricing =
                globalVideoModelCreditsPerSecondSchema.parse({
                  ...Object.fromEntries(
                    Object.entries(videoPricing).filter(
                      ([key]) => !key.startsWith(`${input.configKey}@`)
                    )
                  ),
                  [input.configKey]: Math.max(
                    ...Object.values(input.creditsPerSecondByResolution)
                  ),
                  ...Object.fromEntries(
                    Object.entries(input.creditsPerSecondByResolution).map(
                      ([resolution, price]) => [
                        getVideoPricingResolutionKey(
                          input.configKey,
                          resolution
                        ),
                        price,
                      ]
                    )
                  ),
                });
              nextConfig.videoByFamily[input.configKey] = nextEntry;
              await transaction.saveVideoPricing(nextVideoPricing, actorUserId);
              if (input.maxReferenceImages !== undefined) {
                const nextVideoCapabilities =
                  videoModelCapabilityOverridesSchema.parse({
                    ...videoCapabilities,
                    byModel: {
                      ...videoCapabilities.byModel,
                      [input.configKey]: {
                        maxReferenceImages: input.maxReferenceImages,
                      },
                    },
                  });
                await transaction.saveVideoCapabilities(
                  nextVideoCapabilities,
                  actorUserId
                );
              }
            }

            const receipt: ModelMarketplaceWriteReceipt = {
              requestHash,
              category: input.category,
              configKey: input.configKey,
              resultingRevision,
              completedAt: now.toISOString(),
            };
            nextConfig.writeReceipts = pruneModelMarketplaceWriteReceipts(
              { ...nextConfig.writeReceipts, [receiptKey]: receipt },
              now
            );
            const validatedConfig =
              modelMarketplaceConfigSchema.parse(nextConfig);
            await transaction.saveMarketplaceConfig(
              validatedConfig,
              actorUserId
            );
            await dependencies.audit.record(transaction.auditContext, {
              id: dependencies.ids.create(),
              actorUserId,
              action: "model_configuration.update",
              category: input.category,
              configKey: input.configKey,
              previousRevision: currentRevision,
              resultingRevision,
              coverAction: getCoverAction(input),
              occurredAt: now.toISOString(),
            });
            return {
              output: updateModelConfigurationEntryOutputSchema.parse({
                category: input.category,
                configKey: input.configKey,
                revision: resultingRevision,
              }),
              replayed: false,
              oldCover,
            };
          }
        );
      } catch (error) {
        if (newObjectWritten && replacement) {
          await cleanupCoverIfUnreferenced(
            replacement.reference,
            input,
            "transaction_failed"
          );
        }
        throw error;
      }

      if (transactionResult.replayed) return transactionResult.output;

      try {
        await dependencies.cache.invalidate();
      } catch {
        dependencies.logger.warn({
          event: "model_configuration_cache_invalidation_failed",
          category: input.category,
          configKey: input.configKey,
        });
      }

      const oldCover = transactionResult.oldCover;
      const activeCover =
        input.coverChange.action === "keep"
          ? oldCover
          : input.coverChange.action === "replace"
            ? (replacement?.reference ?? null)
            : null;
      if (oldCover && !coversEqual(oldCover, activeCover)) {
        await cleanupCoverIfUnreferenced(
          oldCover,
          input,
          input.coverChange.action === "remove" ? "removed" : "replaced"
        );
      }
      return transactionResult.output;
    },
  };
}
