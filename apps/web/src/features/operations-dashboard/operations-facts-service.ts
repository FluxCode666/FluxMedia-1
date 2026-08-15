/**
 * 运营总览 epoch 与网页访问领域服务。
 *
 * 使用方：operations 基础事实 UOL binding。服务只接收已验证身份和应用时区，执行
 * 日历一致性检查、同值幂等重放判断和稳定错误分类，不信任数据库返回或调用方时间。
 */
import { randomUUID } from "node:crypto";
import type {
  InitializeOperationsEpochInput,
  InitializeOperationsEpochOutput,
  RecordWebVisitOutput,
} from "@repo/shared/operations-dashboard/facts-contracts";
import {
  formatDateInputInTimeZone,
  parseDateInputInTimeZone,
} from "@repo/shared/time-zone";

import {
  databaseOperationsFactsRepository,
  type OperationsFactsRepository,
} from "./operations-facts-repository";

/** 运营事实服务可稳定映射到 UOL 的错误分类。 */
export type OperationsFactsServiceErrorCode = "validation_error" | "conflict";

/** 不携带 SQL 或数据库行的运营事实领域错误。 */
export class OperationsFactsServiceError extends Error {
  /** 构造可由 binding 映射的稳定错误。 */
  constructor(
    readonly code: OperationsFactsServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OperationsFactsServiceError";
  }
}

/** 服务的可注入依赖；测试使用固定时钟和内存仓储。 */
export type OperationsFactsServiceDependencies = {
  repository: OperationsFactsRepository;
  now: () => Date;
  createAuditId: () => string;
};

const defaultDependencies: OperationsFactsServiceDependencies = {
  repository: databaseOperationsFactsRepository,
  now: () => new Date(),
  createAuditId: randomUUID,
};

/** 比较两个 Date 是否代表同一个有效 UTC 瞬间。 */
function isSameInstant(left: Date, right: Date): boolean {
  return left.getTime() === right.getTime();
}

/**
 * 记录当前 session 用户的有效网页访问。
 *
 * @param input 已由 session 派生的用户、应用时区与可选依赖。
 * @returns 当天是否首次插入；不返回访问时刻或数据库身份。
 * @sideEffects 最多写入一行 user_web_visit。
 * @failure 非法时钟由 Intl 格式化自然抛错，数据库异常原样上抛供布局告警。
 */
export async function recordOperationsWebVisit(
  input: { userId: string; timeZone: string },
  dependencies: Partial<OperationsFactsServiceDependencies> = {}
): Promise<RecordWebVisitOutput> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const visitedAt = resolved.now();
  if (Number.isNaN(visitedAt.getTime())) {
    throw new OperationsFactsServiceError(
      "validation_error",
      "网页访问时间无效"
    );
  }
  const appDate = formatDateInputInTimeZone(visitedAt, input.timeZone);
  const recorded = await resolved.repository.recordWebVisit({
    userId: input.userId,
    appDate,
    visitedAt,
  });
  return { appDate, recorded };
}

/**
 * 初始化不可漂移的生产运营 epoch。
 *
 * @param input 受控命令提供的应用日期、UTC 起点、操作者和幂等 requestId。
 * @param timeZone 部署应用时区。
 * @returns 首次初始化为 initialized=true，同值重放为 false。
 * @sideEffects 首次调用在同一事务写 epoch 和管理员审计。
 * @failure 日期边界不匹配返回 validation_error；已存在不同值返回 conflict。
 */
export async function initializeOperationsAnalyticsEpoch(
  input: InitializeOperationsEpochInput,
  timeZone: string,
  dependencies: Partial<OperationsFactsServiceDependencies> = {}
): Promise<InitializeOperationsEpochOutput> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const startsAt = new Date(input.startsAt);
  const expectedStart = parseDateInputInTimeZone(input.appDate, { timeZone });
  if (!expectedStart || !isSameInstant(startsAt, expectedStart)) {
    throw new OperationsFactsServiceError(
      "validation_error",
      "运营统计起点必须等于应用时区所选自然日零点"
    );
  }
  const result = await resolved.repository.initializeEpoch({
    appDate: input.appDate,
    startsAt,
    initializedBy: input.initializedBy,
    initializationRequestId: input.requestId,
    auditId: resolved.createAuditId(),
    createdAt: resolved.now(),
  });
  if (
    result.epoch.appDate !== input.appDate ||
    !isSameInstant(result.epoch.startsAt, startsAt)
  ) {
    throw new OperationsFactsServiceError(
      "conflict",
      "运营统计起点已经初始化为另一组固定值"
    );
  }
  return {
    appDate: result.epoch.appDate,
    startsAt: result.epoch.startsAt.toISOString(),
    initialized: result.inserted,
  };
}
