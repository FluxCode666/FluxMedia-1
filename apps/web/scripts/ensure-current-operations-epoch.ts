/**
 * 生产发布自动确保运营统计 epoch 的入口。
 *
 * 使用方：生产部署流水线。脚本通过 system-only UOL operation 执行，首次缺失时以
 * APP_TIME_ZONE 当前自然日初始化，已有 epoch 时原样跳过并以成功状态退出。
 */
import { pathToFileURL } from "node:url";

import {
  executeEnsureCurrentOperationsEpochCommand,
  type InvokeEnsureCurrentOperationsEpoch,
  parseEnsureCurrentOperationsEpochCommand,
} from "@/features/operations-dashboard/operations-epoch-ensure-command";

/**
 * 加载自动 epoch operation 与数据库 binding。
 *
 * @returns 已完成 late binding 的 UOL 调用端口。
 * @sideEffects 首次导入会初始化运营基础事实 binding 和数据库模块。
 */
async function createInvokeEnsureCurrentEpoch(): Promise<InvokeEnsureCurrentOperationsEpoch> {
  const [{ invokeOperation }] = await Promise.all([
    import("@repo/shared/uol"),
    import("@/server/uol-bindings/operations-dashboard-facts"),
  ]);
  return async (operation, input, principal) =>
    invokeOperation(operation, input, principal);
}

/**
 * 执行生产 epoch 自动门禁。
 *
 * @param environment 生产 Compose 注入的环境变量。
 * @returns 首次初始化或已有 epoch 结果。
 * @sideEffects 最多首次写入 epoch 与审计；不会修改已有 epoch。
 */
export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  const input = parseEnsureCurrentOperationsEpochCommand(environment);
  const invoke = await createInvokeEnsureCurrentEpoch();
  const result = await executeEnsureCurrentOperationsEpochCommand(
    input,
    invoke
  );
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** 直接执行时显式退出，避免一次性 CLI 被应用数据库连接池保持存活。 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(
        error instanceof Error ? error.message : "未知运营统计自动初始化错误"
      );
      process.exit(1);
    }
  );
}
