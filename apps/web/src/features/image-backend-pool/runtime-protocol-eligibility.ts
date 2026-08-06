/**
 * 账号池媒体协议资格的纯判定。
 *
 * 职责：在模型能力 SQL 已命中后，按请求种类、蒙版要求和账号接入模式执行最后一道
 * 协议过滤。使用方是运行时会话、模型目录与 DB-free 测试；本模块不读取配置或数据库。
 */

/** 协议资格判定所需的最小请求事实。 */
export interface RuntimeProtocolRequest {
  requestKind: "image" | "video";
  requiresMask?: boolean;
}

/** 协议资格判定所需的最小账号事实。 */
export interface RuntimeProtocolMember {
  memberType: "api" | "adobe";
  adobeMode: "gateway" | "direct" | null;
}

/**
 * 判断已获租账号的协议是否能执行当前媒体请求。
 *
 * @param request - 图片/视频类型与可选蒙版要求。
 * @param member - 账号类型和 Adobe 模式。
 * @returns API 可执行图片、蒙版与视频；Adobe Direct 可执行图片和视频；Gateway 仅图片。
 * @sideEffects 无。
 * @failure 不抛错；模型能力已经由获租 SQL 独立筛选。
 */
export function canRuntimeBackendLeaseServeRequest(
  request: RuntimeProtocolRequest,
  member: RuntimeProtocolMember
): boolean {
  if (request.requiresMask && member.memberType !== "api") return false;
  if (request.requestKind !== "video") return true;
  return (
    member.memberType === "api" ||
    (member.memberType === "adobe" && member.adobeMode === "direct")
  );
}
