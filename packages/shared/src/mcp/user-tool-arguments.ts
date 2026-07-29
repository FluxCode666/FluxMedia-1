/**
 * User MCP 工具参数的身份收口规则。
 *
 * 媒体 User MCP 操作刻意不接收 userId，只能由 execute 从 Principal 派生，
 * 避免身份字段进入 JSON Schema 或被客户端伪造。其他非身份字段不在此处
 * 静默删除，交给 strict operation schema 稳定拒绝。
 */
import type { Principal } from "../uol/principal";

/** 为 User MCP 工具生成不可越权的最终参数。 */
export function enrichUserMcpToolArguments(
  operationName: string,
  args: Record<string, unknown>,
  principal: Principal
): Record<string, unknown> {
  if (principal.type !== "apiKey" && principal.type !== "user") return args;
  if (
    operationName === "image.generate" ||
    operationName === "video.generate" ||
    operationName === "video.getStatus" ||
    operationName === "video.listCapabilities" ||
    operationName === "image.listMyHistoryRecords"
  ) {
    const { userId: _discardedUserId, ...identityFreeArgs } = args;
    return identityFreeArgs;
  }
  return { ...args, userId: principal.userId };
}
