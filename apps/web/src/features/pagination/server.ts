/**
 * Web 页面全局分页配置读取适配器。
 *
 * 使用方：各列表页面加载函数。直接读取 Go 公开的分页配置端点，配置缺失或损坏时
 * 回退安全默认值。
 */
import type { PaginationConfig } from "@repo/shared/pagination/config";
import { getPaginationConfig } from "@repo/shared/pagination/server";

/**
 * 读取页面当前应使用的分页默认值和选项。
 *
 * @returns 经业务校验的分页配置；读取失败时为代码默认值。
 */
export function loadPaginationConfig(): Promise<PaginationConfig> {
  return getPaginationConfig();
}
