/**
 * Web 页面全局分页配置读取适配器。
 *
 * 使用方：各列表 Server Component。仅负责初始化 UOL 并以 system Principal
 * 调用只读 operation，避免页面直接绕过统一接口层访问系统设置。
 */
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { invokeOperation } from "@repo/shared/uol";

import { ensureUolInitialized } from "@/server/uol-init";

/**
 * 读取页面当前应使用的分页默认值和选项。
 *
 * @returns 经 UOL 输出 schema 校验的分页配置。
 * @sideEffects 首次调用会初始化 UOL，并读取系统设置缓存。
 */
export async function loadPaginationConfig(): Promise<PaginationConfig> {
  await ensureUolInitialized();
  return invokeOperation<PaginationConfig>(
    "settings.getPaginationConfig",
    {},
    { type: "system", reason: "dashboard-pagination" }
  );
}
