/**
 * 视频任务创建与财务生命周期的 DB-free 不变量。
 *
 * 使用方：video-operations 在权威报价后复核能力快照，并在 metadata 更新、扣费和退款
 * 前验证不可变账单。模块不读取数据库或当前配置，所有外部事实由调用方显式传入。
 */
import {
  type ModelMarketplaceConfig,
  resolveModelMarketplaceEntry,
} from "@repo/shared/model-marketplace";
import {
  resolveEffectiveVideoModelCapability,
  type VideoModelCapabilityOverrides,
} from "@repo/shared/video-generation";
import {
  resolveVideoTaskBilling,
  type VideoBillingSnapshot,
  type VideoTaskBilling,
} from "@repo/shared/video-generation/video-billing-snapshot";

import {
  createVideoCapabilitySnapshot,
  type VideoCapabilitySnapshot,
} from "./video-execution-contract";

/**
 * 比较两个能力快照是否表达完全相同的创建事实。
 *
 * @param left - 事务前早期校验形成的能力快照。
 * @param right - 事务内权威配置重新构造的能力快照。
 * @returns 字段与自定义模型分辨率顺序均一致时返回 true。
 * @sideEffects 无。
 * @failure 不抛错。
 */
function equalVideoCapabilitySnapshots(
  left: VideoCapabilitySnapshot,
  right: VideoCapabilitySnapshot
): boolean {
  return (
    left.version === right.version &&
    left.modelConfigurationRevision === right.modelConfigurationRevision &&
    left.maxReferenceImages === right.maxReferenceImages &&
    left.customModel?.modelId === right.customModel?.modelId &&
    (left.customModel?.supportedResolutions.length ?? 0) ===
      (right.customModel?.supportedResolutions.length ?? 0) &&
    (left.customModel?.supportedResolutions.every(
      (resolution, index) =>
        resolution === right.customModel?.supportedResolutions[index]
    ) ??
      true)
  );
}

/**
 * 用任务创建事务内的权威 marketplace 与能力覆盖复核早期能力快照。
 *
 * @param input - 真实模型、早期 v2 快照及同一报价 statement 返回的配置事实。
 * @returns 无返回；完全一致时允许账单与能力快照同 insert 持久化。
 * @sideEffects 无。
 * @throws Error - revision、自定义模型定义或动态参考图上限发生漂移时 fail closed。
 */
export function assertAuthoritativeVideoCapabilitySnapshot(input: {
  modelId: string;
  capabilitySnapshot: VideoCapabilitySnapshot;
  marketplaceConfig: ModelMarketplaceConfig;
  videoCapabilityOverrides: VideoModelCapabilityOverrides;
}): void {
  const customModel = input.marketplaceConfig.customModels.find(
    (candidate) =>
      candidate.category === "video" && candidate.modelId === input.modelId
  );
  const revision = resolveModelMarketplaceEntry(
    input.marketplaceConfig.videoByFamily[input.modelId],
    "video"
  ).revision;
  const expected = createVideoCapabilitySnapshot({
    modelConfigurationRevision: revision,
    maxReferenceImages: customModel
      ? 0
      : resolveEffectiveVideoModelCapability(
          input.modelId,
          input.videoCapabilityOverrides
        ).input.referenceImages.maxCount,
    ...(customModel
      ? {
          customModel: {
            modelId: customModel.modelId,
            supportedResolutions: customModel.supportedResolutions,
          },
        }
      : {}),
  });
  if (!equalVideoCapabilitySnapshots(input.capabilitySnapshot, expected)) {
    throw new Error("视频模型能力配置在任务创建期间已发生变化");
  }
}

/**
 * 严格解析任务账单并返回新任务的固定分组。
 *
 * @param metadata - 数据库任务 metadata。
 * @returns v1 legacy 标记，或 v2 快照及其 pinned 分组 ID。
 * @sideEffects 无。
 * @throws Error - 版本与账单快照不匹配、摘要损坏或新任务漏写账单时 fail closed。
 */
export function resolvePersistedVideoTaskBilling(metadata: unknown):
  | { billing: Extract<VideoTaskBilling, { kind: "legacy" }> }
  | {
      billing: Extract<VideoTaskBilling, { kind: "snapshot" }>;
      pinnedGroupId: string;
    } {
  const billing = resolveVideoTaskBilling(metadata);
  return billing.kind === "snapshot"
    ? { billing, pinnedGroupId: billing.snapshot.billingGroupId }
    : { billing };
}

/**
 * 验证持久实际金额与 v2 固定报价一致。
 *
 * @param billing - 已严格解析的任务账单。
 * @param amount - 待用于重试、扣费、配额或退款的实际金额。
 * @param action - 安全错误消息中的财务阶段。
 * @returns 无返回；legacy 任务保留原有按秒金额语义。
 * @sideEffects 无。
 * @throws Error - v2 金额不是固定 quotedCredits 时 fail closed。
 */
export function assertVideoSnapshotAmount(
  billing: VideoTaskBilling,
  amount: number,
  action: "扣费" | "重试" | "退款"
): void {
  if (
    billing.kind === "snapshot" &&
    amount !== billing.snapshot.quotedCredits
  ) {
    throw new Error(`视频任务${action}金额与固定报价不一致`);
  }
}

/**
 * 为消费账本投影可审计但不含分组 metadata 或供应商凭据的账单事实。
 *
 * @param snapshot - 创建时已经过摘要校验的 v2 账单快照。
 * @returns 可合并到 credits_transaction.metadata 的最小账单字段。
 * @sideEffects 无。
 * @failure 不抛错。
 */
export function createVideoBillingLedgerMetadata(
  snapshot: VideoBillingSnapshot
): Record<string, string | number> {
  return {
    videoBillingSnapshotDigest: snapshot.digest,
    videoBillingMode: snapshot.mode,
    videoBillingUnit: snapshot.unit,
    videoBillingUnitPrice: snapshot.unitPrice,
    videoBillingQuotedCredits: snapshot.quotedCredits,
  };
}

/**
 * 拒绝 CAS 调用方删除、替换或向 legacy 任务注入账单快照。
 *
 * @param previousMetadata - 当前数据库行中的完整 metadata。
 * @param nextMetadata - 调用方准备整体写回的完整 metadata。
 * @returns 无返回；同为 legacy 或 v2 摘要完全一致时允许更新非财务字段。
 * @sideEffects 无。
 * @throws Error - 任一 metadata 非法或账单身份发生变化时 fail closed。
 */
export function assertVideoBillingMetadataPreserved(
  previousMetadata: unknown,
  nextMetadata: unknown
): void {
  let previous: VideoTaskBilling;
  let next: VideoTaskBilling;
  try {
    previous = resolveVideoTaskBilling(previousMetadata);
    next = resolveVideoTaskBilling(nextMetadata);
  } catch {
    throw new Error("视频任务账单快照不能删除或替换");
  }
  if (previous.kind !== next.kind) {
    throw new Error("视频任务账单快照不能删除或替换");
  }
  if (
    previous.kind === "snapshot" &&
    (next.kind !== "snapshot" ||
      previous.snapshot.digest !== next.snapshot.digest)
  ) {
    throw new Error("视频任务账单快照不能删除或替换");
  }
}
