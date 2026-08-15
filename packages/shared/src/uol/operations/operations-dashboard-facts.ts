/**
 * 运营总览基础事实 UOL 操作。
 *
 * 使用方：已鉴权 dashboard shell 记录有效访问，自动生产门禁写入单一 epoch。
 * 数据库实现由 apps/web late binding 注入，确保权限、输入校验与审计边界先于传输层。
 */
import {
  ensureCurrentOperationsEpochInputSchema,
  operationsEpochOutputSchema,
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

/** 缺失时以部署应用时区当前自然日初始化 epoch，已有值时原样返回。 */
export const ensureCurrentOperationsEpoch = defineOperation({
  name: "operations.ensureCurrentEpoch",
  domain: "operations",
  title: "Ensure Current Operations Analytics Epoch",
  description:
    "生产发布门禁：仅在 epoch 缺失时以服务端应用时区当前自然日初始化；已有不可变值时跳过。",
  input: ensureCurrentOperationsEpochInputSchema,
  output: operationsEpochOutputSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["audit"],
  hasMaintenanceWrite: true,
  /**
   * 表示尚未注入的自动 epoch 门禁执行体。
   *
   * @returns Web binding 注入后返回首次初始化或已有固定 epoch。
   * @failure 未绑定时由 UOL 网关返回 not_implemented。
   */
  async execute() {
    throw new Error("Not yet wired: operations.ensureCurrentEpoch");
  },
});
