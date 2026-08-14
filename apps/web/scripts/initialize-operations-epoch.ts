/**
 * 运营统计 epoch 的显式生产初始化入口。
 *
 * 使用方：发布运维人员。脚本由根环境加载器启动，默认只预演；只有传入 `--apply`
 * 才会以 system Principal 调用 operations.initializeEpoch，且不会输出数据库连接信息。
 */
import { pathToFileURL } from "node:url";

import { resolveDisplayTimeZone } from "@repo/shared/time-zone";

import {
  executeOperationsEpochCommand,
  type InvokeOperationsEpoch,
  parseOperationsEpochCommand,
} from "@/features/operations-dashboard/operations-epoch-command";

/**
 * 仅在显式写入分支加载 UOL 和数据库 binding。
 *
 * @returns 已完成目标 binding 初始化的 epoch operation 调用端口。
 * @sideeffect 首次调用只加载运营基础事实 binding；预演路径不会调用本函数。
 * @failure 数据库配置、binding 或注册失败保持上抛。
 */
async function createInvokeOperationsEpoch(): Promise<InvokeOperationsEpoch> {
  const [{ invokeOperation }] = await Promise.all([
    import("@repo/shared/uol"),
    import("@/server/uol-bindings/operations-dashboard-facts"),
  ]);
  return async (operation, input, principal) =>
    invokeOperation(operation, input, principal);
}

/**
 * 解析环境与命令参数，必要时初始化 UOL 后执行一次预演或幂等写入。
 *
 * @param argumentsList CLI 参数；默认使用当前进程参数。
 * @param environment 进程环境；测试或受控调用可注入替代值。
 * @returns 预演计划或初始化结果。
 * @sideeffect `--apply` 时初始化 UOL binding，并可能首次写 epoch 与管理员审计。
 * @failure 输入、时区、权限、冲突和数据库错误保持上抛，不输出连接配置。
 */
export async function main(
  argumentsList = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env
) {
  const plan = parseOperationsEpochCommand(
    argumentsList,
    environment,
    resolveDisplayTimeZone(null, environment.APP_TIME_ZONE)
  );
  const invokeOperationsEpoch = plan.apply
    ? await createInvokeOperationsEpoch()
    : async () => {
        throw new Error("预演模式不得调用运营统计起点写入 operation");
      };
  const result = await executeOperationsEpochCommand(
    plan,
    invokeOperationsEpoch
  );
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/** 直接执行时提供稳定退出码，导入测试不会连接数据库。 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "未知运营统计起点初始化错误"
    );
    process.exitCode = 1;
  });
}
