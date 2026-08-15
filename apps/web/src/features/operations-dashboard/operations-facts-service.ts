/**
 * 运营总览 epoch 与网页访问领域服务。
 *
 * 使用方：operations 基础事实 UOL binding。服务只接收已验证身份和应用时区，执行
 * 日历一致性检查、锁内当前日派生和稳定错误分类，不信任数据库返回或调用方时间。
 */
import { randomUUID } from "node:crypto";
import type {
  EnsureCurrentOperationsEpochInput,
  OperationsEpochOutput,
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
export type OperationsFactsServiceErrorCode = "validation_error";

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
 * 为生产发布确保不可变运营 epoch 已存在。
 *
 * @param input 发布版本或部署身份，不接受调用方日期。
 * @param timeZone 部署应用时区；首次初始化的自然日和 UTC 零点均由服务端派生。
 * @returns 空表首次初始化为 true；已有任意不可变 epoch 时原样返回 false。
 * @sideEffects 首次调用在同一事务写 epoch 和管理员审计，后续部署只读已有值。
 * @failure 服务器时钟或应用时区无法形成有效自然日零点时返回 validation_error。
 */
export async function ensureCurrentOperationsAnalyticsEpoch(
  input: EnsureCurrentOperationsEpochInput,
  timeZone: string,
  dependencies: Partial<OperationsFactsServiceDependencies> = {}
): Promise<OperationsEpochOutput> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const result = await resolved.repository.ensureEpoch(() => {
    const createdAt = resolved.now();
    if (Number.isNaN(createdAt.getTime())) {
      throw new OperationsFactsServiceError(
        "validation_error",
        "运营统计初始化时间无效"
      );
    }
    const appDate = formatDateInputInTimeZone(createdAt, timeZone);
    const startsAt = parseDateInputInTimeZone(appDate, { timeZone });
    if (!startsAt) {
      throw new OperationsFactsServiceError(
        "validation_error",
        "无法解析运营统计当前自然日零点"
      );
    }
    return {
      appDate,
      startsAt,
      initializedBy: input.initializedBy,
      initializationRequestId: `operations-epoch-${appDate}`,
      auditId: resolved.createAuditId(),
      createdAt,
    };
  });
  return {
    appDate: result.epoch.appDate,
    startsAt: result.epoch.startsAt.toISOString(),
    initialized: result.inserted,
  };
}
