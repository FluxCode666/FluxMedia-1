/**
 * 统一媒体后端的 DB-free 调度层。
 *
 * 职责：定义获租请求/结果、候选资格和稳定错误，并复用共享策略排序器选出候选。
 * 使用方：数据库 repository 在同一 PostgreSQL 事务中读取候选、调用本模块并写入租约。
 * 关键依赖：`@repo/shared/image-backend/scheduling-policy`；本文件不得导入数据库。
 */
import {
  type BackendSchedulingCandidate,
  type BackendSchedulingStrategy,
  sortBackendSchedulingCandidates,
} from "@repo/shared/image-backend/scheduling-policy";

/** repository 交给纯调度层的统一成员事实。 */
export interface BackendAcquireCandidate extends BackendSchedulingCandidate {
  groupIds: readonly string[];
  supportedModelIds: readonly string[];
  isEnabled: boolean;
  contentSafetyEnabled: boolean;
  cooldownUntil: Date | null;
  hasTerminalError: boolean;
}

/** 一次获租尝试固定使用的请求快照。 */
export interface BackendMemberAcquireRequest {
  groupId: string;
  modelId: string;
  strategy: BackendSchedulingStrategy;
  contentSafetyRequired: boolean;
  excludedMemberIds: readonly string[];
  now: Date;
}

/** 候选未通过通用资格过滤的稳定原因。 */
export type BackendCandidateIneligibilityReason =
  | "disabled"
  | "terminal_error"
  | "cooling_down"
  | "wrong_group"
  | "unsupported_model"
  | "content_safety_required"
  | "excluded"
  | "invalid_capacity"
  | "at_capacity";

/** 调度失败的稳定错误码。 */
export type BackendSchedulerErrorCode =
  | "no_eligible_member"
  | "infrastructure_unavailable";

/** 上层可稳定映射且不泄露数据库细节的调度错误。 */
export class BackendSchedulerError extends Error {
  /**
   * 创建调度错误。
   *
   * @param code 稳定错误码。
   * @param message 可安全暴露给上层的错误消息。
   * @param cause 原始异常，仅供受控日志记录，不得直接返回客户端。
   */
  constructor(
    readonly code: BackendSchedulerErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackendSchedulerError";
  }
}

/** 纯层已选出候选，但 repository 尚未持久化租约。 */
export interface BackendMemberSelectedResult<
  T extends BackendAcquireCandidate,
> {
  status: "selected";
  strategy: BackendSchedulingStrategy;
  candidate: T;
  eligibleCandidateCount: number;
}

/** 当前请求没有任何合格候选。 */
export interface BackendMemberUnavailableResult {
  status: "unavailable";
  strategy: BackendSchedulingStrategy;
  error: BackendSchedulerError;
}

/** 纯候选选择结果。 */
export type BackendMemberSelectionResult<T extends BackendAcquireCandidate> =
  | BackendMemberSelectedResult<T>
  | BackendMemberUnavailableResult;

/** repository 成功持久化的租约标识。 */
export interface BackendLeaseGrant {
  leaseId: string;
  ownerToken: string;
  expiresAt: Date;
}

/** repository 完成同事务获租后返回给编排层的结果。 */
export type BackendMemberAcquireResult<T extends BackendAcquireCandidate> =
  | {
      status: "acquired";
      strategy: BackendSchedulingStrategy;
      member: T;
      lease: BackendLeaseGrant;
      eligibleCandidateCount: number;
    }
  | BackendMemberUnavailableResult;

/**
 * repository 提供的原子获租执行器。
 *
 * 执行器必须在同一事务中读取并锁定候选、调用 select、写入租约和更新获租计数。
 * `select` 返回 selected 不代表已获租；只有执行器持久化成功后才能返回 acquired。
 */
export type BackendAcquireTransaction<T extends BackendAcquireCandidate> = (
  request: BackendMemberAcquireRequest,
  select: (candidates: readonly T[]) => BackendMemberSelectionResult<T>
) => Promise<BackendMemberAcquireResult<T>>;

/** 将模型 ID 归一为大小写无关的显式能力键。 */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

/** 判断候选是否显式声明请求模型；空能力列表始终 fail-closed。 */
function supportsRequestedModel(
  supportedModelIds: readonly string[],
  requestedModelId: string
): boolean {
  const normalizedRequestedModelId = normalizeModelId(requestedModelId);
  if (!normalizedRequestedModelId || supportedModelIds.length === 0) {
    return false;
  }
  return supportedModelIds.some(
    (modelId) => normalizeModelId(modelId) === normalizedRequestedModelId
  );
}

/**
 * 返回候选的首个不合格原因。
 *
 * @param candidate repository 在事务中读取的统一成员快照。
 * @param request 本次获租的不可变请求快照。
 * @returns `null` 表示候选合格，否则返回稳定过滤原因。
 */
export function getBackendCandidateIneligibilityReason(
  candidate: BackendAcquireCandidate,
  request: BackendMemberAcquireRequest
): BackendCandidateIneligibilityReason | null {
  if (!candidate.isEnabled) return "disabled";
  if (candidate.hasTerminalError) return "terminal_error";
  if (
    candidate.cooldownUntil &&
    candidate.cooldownUntil.getTime() > request.now.getTime()
  ) {
    return "cooling_down";
  }
  if (!candidate.groupIds.includes(request.groupId)) return "wrong_group";
  if (!supportsRequestedModel(candidate.supportedModelIds, request.modelId)) {
    return "unsupported_model";
  }
  if (request.contentSafetyRequired && !candidate.contentSafetyEnabled) {
    return "content_safety_required";
  }
  if (request.excludedMemberIds.includes(candidate.id)) return "excluded";
  if (
    !Number.isInteger(candidate.inflightCount) ||
    candidate.inflightCount < 0 ||
    !Number.isInteger(candidate.concurrency) ||
    candidate.concurrency <= 0
  ) {
    return "invalid_capacity";
  }
  if (candidate.inflightCount >= candidate.concurrency) return "at_capacity";
  return null;
}

/**
 * 判断候选是否满足本次获租的全部通用资格。
 *
 * @param candidate repository 提供的成员快照。
 * @param request 本次获租请求。
 * @returns 候选可参与策略排序时返回 true。
 */
export function isBackendCandidateEligible(
  candidate: BackendAcquireCandidate,
  request: BackendMemberAcquireRequest
): boolean {
  return getBackendCandidateIneligibilityReason(candidate, request) === null;
}

/**
 * 过滤候选并按请求中的全局策略确定本次首选成员。
 *
 * @param candidates 同一事务内锁定并计算有效在飞数后的候选快照。
 * @param request 本次获租的分组、模型、策略和排除集合。
 * @returns 已选候选，或稳定的无合格成员结果；不修改输入数组。
 */
export function selectBackendMemberForAcquire<
  T extends BackendAcquireCandidate,
>(
  candidates: readonly T[],
  request: BackendMemberAcquireRequest
): BackendMemberSelectionResult<T> {
  const eligibleCandidates = candidates.filter((candidate) =>
    isBackendCandidateEligible(candidate, request)
  );
  const [candidate] = sortBackendSchedulingCandidates(
    eligibleCandidates,
    request.strategy
  );

  if (!candidate) {
    return {
      status: "unavailable",
      strategy: request.strategy,
      error: new BackendSchedulerError(
        "no_eligible_member",
        "当前分组没有可用于该模型的媒体后端"
      ),
    };
  }

  return {
    status: "selected",
    strategy: request.strategy,
    candidate,
    eligibleCandidateCount: eligibleCandidates.length,
  };
}

/**
 * 在 repository 的数据库事务中执行一次获租。
 *
 * @param request 本次获租请求。
 * @param transaction 原子读取、选择、插入租约和更新计数的执行器。
 * @returns 已持久化的租约，或无合格成员结果。
 * @throws BackendSchedulerError 基础设施失败时稳定抛错，不创建本地租约或降级候选。
 */
export async function acquireBackendMember<T extends BackendAcquireCandidate>(
  request: BackendMemberAcquireRequest,
  transaction: BackendAcquireTransaction<T>
): Promise<BackendMemberAcquireResult<T>> {
  try {
    return await transaction(request, (candidates) =>
      selectBackendMemberForAcquire(candidates, request)
    );
  } catch (cause) {
    throw new BackendSchedulerError(
      "infrastructure_unavailable",
      "媒体后端调度基础设施不可用",
      cause
    );
  }
}
