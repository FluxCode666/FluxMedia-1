/**
 * 运营总览基础事实 operation 契约。
 *
 * 使用方：UOL operation 定义、Web late binding 与自动生产初始化命令。契约只描述
 * epoch 和有效网页访问的最小输入输出，不暴露数据库字段、用户筛选或支付数据。
 */
import { z } from "zod";

import { parseDateInputInTimeZone } from "../time-zone";

/** 判断固定格式字符串是否为真实存在的 Gregorian 自然日。 */
function isValidGregorianDate(value: string): boolean {
  return parseDateInputInTimeZone(value, { timeZone: "UTC" }) !== null;
}

/** 运营事实使用的严格 Gregorian 自然日。 */
export const operationsAppDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "必须使用 YYYY-MM-DD 格式")
  .refine(isValidGregorianDate, "日期必须是有效的 Gregorian 日期");

/** 有效网页访问记录不接受调用方时间或身份字段。 */
export const recordWebVisitInputSchema = z.object({}).strict();

/** 有效网页访问幂等写入结果。 */
export const recordWebVisitOutputSchema = z
  .object({
    appDate: operationsAppDateSchema,
    recorded: z.boolean(),
  })
  .strict();

/** 自动生产门禁只接受发布身份；日期与 UTC 起点必须由服务端时钟派生。 */
export const ensureCurrentOperationsEpochInputSchema = z
  .object({
    initializedBy: z.string().trim().min(1).max(255),
  })
  .strict();

/** 生产 epoch 自动初始化或幂等跳过结果。 */
export const operationsEpochOutputSchema = z
  .object({
    appDate: operationsAppDateSchema,
    startsAt: z.string().datetime({ offset: true }),
    initialized: z.boolean(),
  })
  .strict();

export type RecordWebVisitInput = z.infer<typeof recordWebVisitInputSchema>;
export type RecordWebVisitOutput = z.infer<typeof recordWebVisitOutputSchema>;
export type OperationsEpochOutput = z.infer<typeof operationsEpochOutputSchema>;
export type EnsureCurrentOperationsEpochInput = z.infer<
  typeof ensureCurrentOperationsEpochInputSchema
>;
