/**
 * Adobe direct 真实调用后的被动凭据健康触发器。
 *
 * 职责：当缓存 Token 刷新失败或被 Adobe 拒绝时立即触发账号级 Express/Firefly
 * 双 Profile 评估；额度耗尽保持为独立可用额度状态。使用方是 direct 媒体调用链。
 */
import { logError } from "@repo/shared/logger";

/** 运行时短期凭据状态；active 与 exhausted 均不代表凭据身份失败。 */
export type AdobeRuntimeCredentialStatus =
  | "active"
  | "error"
  | "exhausted"
  | "invalid";

type PassiveHealthDependencies = {
  evaluate(memberId: string): Promise<unknown>;
  reportFailure(error: unknown, memberId: string): void;
};

/** 延迟加载健康运行时，避免 direct 模块初始化时形成不必要的重依赖。 */
async function evaluatePassiveHealth(memberId: string): Promise<void> {
  const { checkAdobeCredentialHealthPassively } = await import(
    "./adobe-credential-health-runtime"
  );
  await checkAdobeCredentialHealthPassively(memberId);
}

const defaultDependencies: PassiveHealthDependencies = {
  evaluate: evaluatePassiveHealth,
  reportFailure(error, memberId) {
    logError(error, {
      source: "adobe-credential-passive-health",
      memberId,
    });
  },
};

/**
 * 根据真实调用得到的短期状态同步账号级凭据健康。
 *
 * @param input 成员 ID 与本次落库状态。
 * @param dependencies 可测试的双 Profile 评估和日志端口。
 * @returns 无返回值；被动评估失败只记录日志，不覆盖原媒体调用错误。
 * @sideEffects error/invalid 时发起双 Profile Adobe 请求并更新健康摘要。
 */
export async function synchronizeAdobeCredentialHealthAfterRuntimeStatus(
  input: { memberId: string; status: AdobeRuntimeCredentialStatus },
  dependencies: PassiveHealthDependencies = defaultDependencies
): Promise<void> {
  if (input.status !== "error" && input.status !== "invalid") return;
  try {
    await dependencies.evaluate(input.memberId);
  } catch (error) {
    dependencies.reportFailure(error, input.memberId);
  }
}
