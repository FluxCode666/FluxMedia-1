/**
 * 全局列表分页配置契约。
 *
 * 使用方：系统设置写入校验、UOL 配置读取以及各页面 URL 参数解析。
 * 本文件保持 DB-free，确保分页默认值和白名单规则可在前后端安全复用。
 */
import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

/** 允许管理员配置的分页大小白名单；默认值 20 必须始终可选。 */
export const paginationPageSizeOptionsSchema = z
  .array(z.number().int().min(1).max(MAX_PAGE_SIZE))
  .min(1)
  .max(10)
  .superRefine((options, context) => {
    if (new Set(options).size !== options.length) {
      context.addIssue({
        code: "custom",
        message: "分页大小不能重复",
      });
    }
    if (!options.includes(DEFAULT_PAGE_SIZE)) {
      context.addIssue({
        code: "custom",
        message: `分页大小必须包含默认值 ${DEFAULT_PAGE_SIZE}`,
      });
    }
  })
  .transform((options) => [...options].sort((left, right) => left - right));

/** 页面消费的稳定分页配置输出。 */
export const paginationConfigSchema = z
  .object({
    defaultPageSize: z.literal(DEFAULT_PAGE_SIZE),
    pageSizeOptions: paginationPageSizeOptionsSchema,
  })
  .strict();

export type PaginationConfig = z.output<typeof paginationConfigSchema>;

/**
 * 将不可信运行时设置收窄为稳定分页配置。
 *
 * @param configuredOptions - 数据库或环境变量中的分页大小 JSON。
 * @returns 合法配置的升序副本；非法配置回退代码默认值。
 */
export function parsePaginationConfig(
  configuredOptions: unknown
): PaginationConfig {
  const parsed = paginationPageSizeOptionsSchema.safeParse(configuredOptions);
  return {
    defaultPageSize: DEFAULT_PAGE_SIZE,
    pageSizeOptions: parsed.success
      ? parsed.data
      : [...DEFAULT_PAGE_SIZE_OPTIONS],
  };
}

/**
 * 从公开 URL 查询参数解析分页大小。
 *
 * @param value - Next.js searchParams 中的原始值；数组视为非法。
 * @param config - 当前系统允许的分页大小白名单。
 * @returns 白名单中的整数，否则回退固定默认值 20。
 */
export function parseConfiguredPageSize(
  value: string | string[] | undefined,
  config: PaginationConfig
): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return config.defaultPageSize;
  }
  const candidate = Number(value);
  return config.pageSizeOptions.includes(candidate)
    ? candidate
    : config.defaultPageSize;
}
