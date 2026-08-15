/**
 * 运营统计 epoch 初始化命令核心。
 *
 * 使用方：显式生产初始化脚本与 DB-free 测试。核心只解析受控环境输入、校验应用
 * 时区零点并决定预演或调用 UOL，不读取数据库配置，也不负责加载环境文件。
 */
import {
  type InitializeOperationsEpochInput,
  type InitializeOperationsEpochOutput,
  initializeOperationsEpochInputSchema,
} from "@repo/shared/operations-dashboard/facts-contracts";
import { parseDateInputInTimeZone } from "@repo/shared/time-zone";

const APPLY_ARGUMENT = "--apply";
const SYSTEM_REASON = "operations-epoch-initialization-command";

/** 初始化命令允许读取的环境变量集合。 */
export type OperationsEpochCommandEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** 已完成输入和时区边界校验的初始化计划。 */
export type OperationsEpochCommandPlan = {
  apply: boolean;
  input: InitializeOperationsEpochInput;
  timeZone: string;
};

/** 命令需要的最小 UOL 调用端口，便于测试阻止预演阶段产生写入。 */
export type InvokeOperationsEpoch = (
  operation: "operations.initializeEpoch",
  input: InitializeOperationsEpochInput,
  principal: { type: "system"; reason: string }
) => Promise<InitializeOperationsEpochOutput>;

/** 从环境变量读取一个必填、非空的命令输入。 */
function requireEnvironmentValue(
  environment: OperationsEpochCommandEnvironment,
  key: string
): string {
  const value = environment[key]?.trim();
  if (!value) {
    throw new Error(`缺少必填环境变量 ${key}`);
  }
  return value;
}

/**
 * 解析初始化命令并在任何写入前验证不可变 epoch 的日历边界。
 *
 * @param argumentsList CLI 参数；无参数为预演，只有 `--apply` 会允许写入。
 * @param environment 显式 epoch 输入，不读取或回显其它环境配置。
 * @param timeZone 当前部署的应用时区。
 * @returns 可安全执行的初始化计划。
 * @failure 缺失输入、未知参数、非法日期或 UTC 起点不等于自然日零点时抛错。
 */
export function parseOperationsEpochCommand(
  argumentsList: readonly string[],
  environment: OperationsEpochCommandEnvironment,
  timeZone: string
): OperationsEpochCommandPlan {
  const normalizedArguments = argumentsList.filter(
    (argument) => argument !== "--"
  );
  const unknownArgument = normalizedArguments.find(
    (argument) => argument !== APPLY_ARGUMENT
  );
  if (unknownArgument || normalizedArguments.length > 1) {
    throw new Error(
      `未知参数 ${unknownArgument ?? normalizedArguments.join(" ")}`
    );
  }

  const input = initializeOperationsEpochInputSchema.parse({
    appDate: requireEnvironmentValue(environment, "OPERATIONS_EPOCH_APP_DATE"),
    startsAt: requireEnvironmentValue(
      environment,
      "OPERATIONS_EPOCH_STARTS_AT"
    ),
    initializedBy: requireEnvironmentValue(
      environment,
      "OPERATIONS_EPOCH_INITIALIZED_BY"
    ),
    requestId: requireEnvironmentValue(
      environment,
      "OPERATIONS_EPOCH_REQUEST_ID"
    ),
  });
  const expectedStart = parseDateInputInTimeZone(input.appDate, { timeZone });
  const actualStart = new Date(input.startsAt);
  if (
    !expectedStart ||
    Number.isNaN(actualStart.getTime()) ||
    expectedStart.getTime() !== actualStart.getTime()
  ) {
    throw new Error(
      "OPERATIONS_EPOCH_STARTS_AT 必须精确等于应用时区自然日零点"
    );
  }

  return {
    apply: normalizedArguments.includes(APPLY_ARGUMENT),
    input: { ...input, startsAt: actualStart.toISOString() },
    timeZone,
  };
}

/**
 * 执行预演或通过 UOL 初始化 epoch。
 *
 * @param plan 已校验的初始化计划。
 * @param invoke UOL 调用端口。
 * @returns 预演计划或数据库幂等初始化结果。
 * @sideeffect 只有 plan.apply 为 true 时调用一次 operations.initializeEpoch。
 * @failure UOL 权限、冲突、数据库或审计错误保持上抛给 CLI 统一处理。
 */
export async function executeOperationsEpochCommand(
  plan: OperationsEpochCommandPlan,
  invoke: InvokeOperationsEpoch
) {
  if (!plan.apply) {
    return { mode: "preview" as const, ...plan };
  }
  const result = await invoke("operations.initializeEpoch", plan.input, {
    type: "system",
    reason: SYSTEM_REASON,
  });
  return {
    mode: "applied" as const,
    result,
    timeZone: plan.timeZone,
  };
}
