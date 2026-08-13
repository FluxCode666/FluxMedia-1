/**
 * 推广关系列表契约。
 *
 * 使用方：referral.listMyRelationships UOL、推广关系读取服务与用户推广页。
 * 关系明细与推广统计分开返回；列表一次返回当前用户的全部脱敏邀请记录。
 */

import { z } from "zod";

import { referralRelationshipStatusSchema } from "./contract";

/** 推广关系列表不接受客户端查询条件或身份字段。 */
export const referralRelationshipListInputSchema = z.object({}).strict();

/** 单条邀请记录的严格公开字段。 */
export const referralRelationshipListItemSchema = z
  .object({
    id: z.string(),
    inviteeName: z.string(),
    inviteeEmail: z.string(),
    status: referralRelationshipStatusSchema,
    inviterRewardCredits: z.number().nonnegative(),
    inviteeRewardCredits: z.number().nonnegative(),
    createdAt: z.string().datetime(),
    rewardedAt: z.string().datetime().nullable(),
  })
  .strict();

/** 全量邀请记录输出；总数与 records 使用同一次查询快照。 */
export const referralRelationshipListOutputSchema = z
  .object({
    records: z.array(referralRelationshipListItemSchema),
    totalCount: z.number().int().nonnegative().safe(),
  })
  .strict();

export type ReferralRelationshipListInput = z.output<
  typeof referralRelationshipListInputSchema
>;
export type ReferralRelationshipListItem = z.output<
  typeof referralRelationshipListItemSchema
>;
export type ReferralRelationshipListOutput = z.output<
  typeof referralRelationshipListOutputSchema
>;
