/**
 * 运营总览基础事实 UOL 操作。
 *
 * 使用方：已鉴权 dashboard shell 记录有效访问，生产初始化命令写入单一 epoch。
 * 数据库实现由 apps/web late binding 注入，确保权限、输入校验与审计边界先于传输层。
 */
import {
  initializeOperationsEpochInputSchema,
  initializeOperationsEpochOutputSchema,
  recordWebVisitInputSchema,
  recordWebVisitOutputSchema,
} from "../../operations-dashboard/facts-contracts";
import { defineOperation } from "../registry";

/** 为当前真实 session 用户记录一个应用自然日的有效网页访问。 */
export const recordWebVisit = defineOperation({
  name: "operations.recordWebVisit",
  domain: "operations",
  title: "Record Operations Web Visit",
  description:
    "为当前站内 session 用户记录应用自然日访问事实；不接受 userId、页面路径、IP 或 UA。",
  input: recordWebVisitInputSchema,
  output: recordWebVisitOutputSchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  hasMaintenanceWrite: true,
  /**
   * 表示尚未注入的访问事实执行体。
   *
   * @returns stub 不返回结果；Web binding 替换后返回是否首次写入该自然日。
   * @failure 未绑定时由 UOL 网关返回 not_implemented。
   */
  async execute() {
    throw new Error("Not yet wired: operations.recordWebVisit");
  },
});

/** 幂等初始化运营统计 epoch；仅允许进程内 system Principal 调用。 */
export const initializeOperationsEpoch = defineOperation({
  name: "operations.initializeEpoch",
  domain: "operations",
  title: "Initialize Operations Analytics Epoch",
  description:
    "以显式应用日期和 UTC 起点初始化不可漂移的运营统计 epoch；不同值重试会冲突。",
  input: initializeOperationsEpochInputSchema,
  output: initializeOperationsEpochOutputSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: {
    kind: "required",
    keyField: "requestId",
    scope: "global",
  },
  sideEffects: ["audit"],
  hasMaintenanceWrite: true,
  /**
   * 表示尚未注入的 epoch 初始化执行体。
   *
   * @returns stub 不返回结果；Web binding 替换后返回首次初始化或同值重放。
   * @failure 未绑定时由 UOL 网关返回 not_implemented。
   */
  async execute() {
    throw new Error("Not yet wired: operations.initializeEpoch");
  },
});
