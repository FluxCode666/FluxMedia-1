/**
 * MCP User 工具工厂
 *
 * 职责：根据调用者 Principal，从 UOL Registry 中
 * 筛选出用户可通过 MCP 访问的操作子集，并转化为 MCP Tool 描述。
 *
 * 筛选规则：
 * - 仅暴露已接线的图片、视频与本人统一历史操作
 * - 绝不暴露管理员操作
 *
 * 使用方：MCP user route handler（tools/list 方法）
 * 关键依赖：../uol/registry（listOperations、getOperation）、../uol/types
 */

import type { Principal } from "../uol/principal";
import { getOperation, isOperationBound } from "../uol/registry";
import type { OperationDefinition } from "../uol/types";
import { isOperationAgentExposable } from "./agent-exposure";
import { zodToMcpJsonSchema } from "./json-schema";

/**
 * MCP Tool 描述 - 对应 MCP 协议 tools/list 响应中的单个工具项
 */
export interface McpToolDescriptor {
  /** 工具名称（对应 UOL operation name） */
  name: string;
  /** 人类可读描述 */
  description: string;
  /** JSON Schema 格式的输入 schema */
  inputSchema: Record<string, unknown>;
  /** MCP Tool 注解（只读/破坏性/副作用等） */
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    sideEffects: string[];
    domain: string;
  };
}

/**
 * 用户 MCP 可访问的操作白名单。
 *
 * 仅列出终端用户通过 MCP 协议应可调用的操作名称。
 * 管理员操作、内部操作、危险操作一律不在此列。
 *
 * 这是传输层显式边界：即使 registry 中存在并已绑定其他终端用户操作，
 * User MCP 也不得自动扩权。
 */
const USER_MCP_ALLOWED_OPERATIONS: readonly string[] = [
  "image.generate",
  "video.generate",
  "video.getStatus",
  "video.listCapabilities",
  "image.listMyHistoryRecords",
] as const;

/**
 * 构建用户 MCP 工具列表。
 *
 * 从 UOL Registry 中读取白名单操作并转化为 MCP Tool 描述列表。
 *
 * @param principal - 已鉴权的调用者身份
 * @returns 用户可调用的 MCP 工具描述列表
 *
 * 副作用：无（纯读取 registry + 过滤）
 * 边界：registry 中不存在的操作名静默跳过（不报错）
 */
export function buildUserMcpTools(principal: Principal): McpToolDescriptor[] {
  if (principal.type !== "apiKey" || principal.credentialKind !== "mcp") {
    return [];
  }
  const tools: McpToolDescriptor[] = [];

  for (const opName of USER_MCP_ALLOWED_OPERATIONS) {
    const def: OperationDefinition | undefined = getOperation(opName);
    if (!def) continue;
    if (!isOperationAgentExposable(def)) continue;
    if (!isOperationBound(opName)) continue;

    // 基本 access 校验：apiKey 和 protected 类型操作对 MCP user 均可
    if (
      def.access.kind !== "protected" &&
      def.access.kind !== "apiKey" &&
      def.access.kind !== "owner"
    ) {
      continue;
    }

    tools.push({
      name: def.name,
      description: def.description,
      inputSchema: zodToMcpJsonSchema(def.input),
      annotations: {
        readOnly: def.readOnly,
        destructive: def.destructive,
        sideEffects: [...def.sideEffects],
        domain: def.domain,
      },
    });
  }

  return tools;
}
