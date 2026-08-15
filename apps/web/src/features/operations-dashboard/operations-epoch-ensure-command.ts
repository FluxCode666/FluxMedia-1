/**
 * 生产部署自动确保运营统计 epoch 的命令核心。
 *
 * 使用方：生产发布脚本与 DB-free 测试。命令只接收发布身份，日期与 UTC 零点由
 * operations.ensureCurrentEpoch 在服务器应用时区内派生，禁止部署调用方传入日期。
 */
import type {
  EnsureCurrentOperationsEpochInput,
  OperationsEpochOutput,
} from "@repo/shared/operations-dashboard/facts-contracts";
import { ensureCurrentOperationsEpochInputSchema } from "@repo/shared/operations-dashboard/facts-contracts";

const SYSTEM_REASON = "operations-epoch-deployment-gate";

/** 自动门禁允许读取的最小环境变量集合。 */
export type EnsureCurrentOperationsEpochEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** 自动门禁需要的最小 UOL 调用端口。 */
export type InvokeEnsureCurrentOperationsEpoch = (
  operation: "operations.ensureCurrentEpoch",
  input: EnsureCurrentOperationsEpochInput,
  principal: { type: "system"; reason: string }
) => Promise<OperationsEpochOutput>;

/**
 * 解析部署身份，拒绝日期、时区或数据库字段从命令输入进入领域层。
 *
 * @param environment 生产 Compose 注入的环境变量。
 * @returns 经严格 schema 校验的发布身份。
 * @failure 缺失或空发布身份时抛出可定位错误。
 */
export function parseEnsureCurrentOperationsEpochCommand(
  environment: EnsureCurrentOperationsEpochEnvironment
): EnsureCurrentOperationsEpochInput {
  const initializedBy = environment.OPERATIONS_EPOCH_INITIALIZED_BY?.trim();
  if (!initializedBy) {
    throw new Error("缺少必填环境变量 OPERATIONS_EPOCH_INITIALIZED_BY");
  }
  return ensureCurrentOperationsEpochInputSchema.parse({ initializedBy });
}

/**
 * 通过统一操作层确保生产 epoch 已存在。
 *
 * @param input 已校验发布身份。
 * @param invoke UOL 调用端口。
 * @returns 首次初始化或已有不可变 epoch。
 * @sideEffects 最多首次写入一行 epoch 和一条审计。
 */
export async function executeEnsureCurrentOperationsEpochCommand(
  input: EnsureCurrentOperationsEpochInput,
  invoke: InvokeEnsureCurrentOperationsEpoch
): Promise<OperationsEpochOutput> {
  return invoke("operations.ensureCurrentEpoch", input, {
    type: "system",
    reason: SYSTEM_REASON,
  });
}
