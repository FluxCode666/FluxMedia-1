/**
 * 推广领域的无数据库契约。
 *
 * 使用方：公开推广入口、注册归因、用户看板和 UOL 输出 schema。集中维护公开
 * 推广码及关系状态的边界，避免不同传输层各自放宽或改变规则。
 */
import { z } from "zod";

/** 将客户端输入收敛为固定大写格式；非法推广码返回 null。 */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{6,32}$/.test(code) ? code : null;
}

export const referralRelationshipStatusSchema = z.enum([
  "pending",
  "rewarded",
  "skipped",
]);

export type ReferralRelationshipStatus = z.infer<
  typeof referralRelationshipStatusSchema
>;
