/**
 * Adobe 凭据健康 UOL late binding。
 *
 * 职责：把内部 cron 与管理员立即检查/详情读取绑定到同一运行时服务；所有 operation
 * 都维持 human-only，MCP 不会因本文件接线而获得任何新工具。
 */

import { bindExecute, OperationError } from "@repo/shared/uol";
import {
  checkAdobeCredentialHealth,
  getAdobeCredentialHealth,
  runAdobeCredentialHealthScan,
} from "@/features/image-generation/adobe-credential-health-runtime";
import {
  cleanupAdobeCredentialHealthHistory,
  drainAdobeCredentialNotifications,
} from "@/features/image-generation/adobe-credential-notifications";

/** 将运行时稳定失败映射为不含 Adobe 原始错误的 UOL 错误。 */
function throwAdobeCredentialOperationError(error: unknown): never {
  const message = error instanceof Error ? error.message : "Adobe 凭据操作失败";
  if (message.includes("不存在")) {
    throw new OperationError("not_found", message);
  }
  if (message.includes("正在检查") || message.includes("已停用")) {
    throw new OperationError("conflict", message);
  }
  throw error;
}

/** 内部健康扫描。 */
bindExecute(
  "pool.scanAdobeCredentialHealth",
  async (input: { batchSize: number }) =>
    runAdobeCredentialHealthScan({ batchSize: input.batchSize })
);

/** 内部通知补偿。 */
bindExecute(
  "pool.drainAdobeCredentialNotifications",
  async (input: { batchSize: number }) =>
    drainAdobeCredentialNotifications({ batchSize: input.batchSize })
);

/** 内部终态历史清理。 */
bindExecute(
  "pool.cleanupAdobeCredentialHealthHistory",
  async (input: { batchSize: number }) =>
    cleanupAdobeCredentialHealthHistory({ limit: input.batchSize })
);

/** 管理员立即检查指定 Adobe direct 成员。 */
bindExecute(
  "pool.checkAdobeCredentialHealth",
  async (input: { memberId: string }) => {
    try {
      const result = await checkAdobeCredentialHealth(input.memberId);
      return {
        evaluationId: result.evaluationId,
        disposition: result.disposition,
        health: result.health,
      };
    } catch (error) {
      throwAdobeCredentialOperationError(error);
    }
  }
);

/** 管理员读取指定成员的安全健康摘要与折叠诊断。 */
bindExecute(
  "pool.getAdobeCredentialHealth",
  async (input: { memberId: string }) => {
    try {
      return await getAdobeCredentialHealth(input.memberId);
    } catch (error) {
      throwAdobeCredentialOperationError(error);
    }
  }
);
