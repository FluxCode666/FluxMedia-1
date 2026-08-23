/**
 * UOL 初始化入口 - 确保所有操作绑定在首次调用前完成
 *
 * 职责：懒加载 uol-bindings 模块，触发所有 bindExecute 调用。
 * 使用模块级标志保证只执行一次（幂等）。
 *
 * 使用方：MCP 路由、server-action 传输层在处理请求前调用
 * ensureUolInitialized()，确保 registry 中的 stub 已被替换。
 *
 * 关键依赖：./uol-bindings（实际绑定逻辑）
 *
 * 设计决策：
 * - 动态 import 避免启动时的循环依赖风险
 * - 绑定状态探针保证幂等（多次调用无副作用）
 * - async 允许未来扩展（如异步服务发现）
 */

import { isOperationBound } from "@repo/shared/uol";

const CORE_OPERATION_NAMES = ["image.generate", "video.generate"] as const;
let initPromise: Promise<void> | null = null;

/** 检查当前 Next 服务模块上下文的核心 operation 是否已绑定。 */
function areCoreOperationsBound(): boolean {
  return CORE_OPERATION_NAMES.every((name) => isOperationBound(name));
}

/**
 * 确保 UOL 操作层已完成初始化（所有 bindExecute 已执行）。
 *
 * 调用时机：任何 invokeOperation 调用之前（通常在传输层入口处）。
 * 多次调用安全（幂等），仅首次触发实际绑定。
 * 并发调用安全（共享同一 Promise）。
 */
export async function ensureUolInitialized(): Promise<void> {
  if (areCoreOperationsBound()) return;

  if (!initPromise) {
    initPromise = (async () => {
      await import("./uol-bindings");
      if (!areCoreOperationsBound()) {
        throw new Error("UOL core operations were not bound");
      }
    })();
  }

  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}
