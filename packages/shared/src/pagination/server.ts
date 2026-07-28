/**
 * 全局分页配置服务端读取器。
 *
 * 使用方：settings.getPaginationConfig UOL operation。读取动态系统设置，并在
 * 配置缺失、JSON 损坏或业务校验失败时回退安全默认值。
 */
import { logError } from "../logger";
import { getRuntimeSettingJson } from "../system-settings/index";
import { type PaginationConfig, parsePaginationConfig } from "./config";

/**
 * 读取并校验当前全局分页配置。
 *
 * @returns 稳定分页配置；可选设置不可用时返回代码默认值。
 * @sideEffects 读取系统设置缓存；损坏配置会记录不含原始值的安全错误日志。
 */
export async function getPaginationConfig(): Promise<PaginationConfig> {
  try {
    return parsePaginationConfig(
      await getRuntimeSettingJson("PAGINATION_PAGE_SIZE_OPTIONS")
    );
  } catch (error) {
    logError(error, { source: "pagination-config" });
    return parsePaginationConfig(undefined);
  }
}
