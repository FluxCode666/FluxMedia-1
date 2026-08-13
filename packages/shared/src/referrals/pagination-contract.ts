/**
 * 推广关系分页契约。
 *
 * 使用方：referral.listMyRelationships UOL、推广关系读取服务与用户推广页。
 * 关系明细与推广统计分开返回，避免当前分页记录被误用为全量统计。
 */

import { z } from "zod";
import { createOffsetPaginationOutputSchema } from "../pagination/contracts";

import { referralRelationshipStatusSchema } from "./contract";

export const referralRelationshipListInputSchema = z
  .object({
    page: z.number().int().positive().default(1),
    pageSize: z
      .union([z.literal(10), z.literal(20), z.literal(50)])
      .default(20),
  })
  .strict();

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

export const referralRelationshipListOutputSchema =
  createOffsetPaginationOutputSchema(referralRelationshipListItemSchema);

export type ReferralRelationshipListInput = z.output<
  typeof referralRelationshipListInputSchema
>;
export type ReferralRelationshipListItem = z.output<
  typeof referralRelationshipListItemSchema
>;
export type ReferralRelationshipListOutput = z.output<
  typeof referralRelationshipListOutputSchema
>;
