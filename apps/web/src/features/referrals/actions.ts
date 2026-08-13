"use server";

/** 推广看板 Server Action：薄适配真实会话到 UOL。 */
import { normalizeUserRole } from "@repo/shared/auth/roles";
import {
  type ReferralRelationshipListOutput,
  referralRelationshipListInputSchema,
} from "@repo/shared/referrals/pagination-contract";
import { protectedAction } from "@repo/shared/safe-action";
import { invokeOperation } from "@repo/shared/uol";
import type { referralDashboardOutputSchema } from "@repo/shared/uol/operations/referrals";
import type { z } from "zod";

export type ReferralDashboardOutput = z.infer<
  typeof referralDashboardOutputSchema
>;

export const getMyReferralDashboardAction = protectedAction
  .metadata({ action: "referral.getMyDashboard" })
  .action(async ({ ctx }) =>
    invokeOperation<ReferralDashboardOutput>(
      "referral.getMyDashboard",
      {},
      {
        type: "user",
        userId: ctx.userId,
        role: normalizeUserRole(ctx.user.role),
      }
    )
  );

/** 推广关系分页 Action：只把已校验页码传给 human-only UOL。 */
export const listMyReferralRelationshipsAction = protectedAction
  .metadata({ action: "referral.listMyRelationships" })
  .inputSchema(referralRelationshipListInputSchema)
  .action(async ({ parsedInput, ctx }) =>
    invokeOperation<ReferralRelationshipListOutput>(
      "referral.listMyRelationships",
      parsedInput,
      {
        type: "user",
        userId: ctx.userId,
        role: normalizeUserRole(ctx.user.role),
      }
    )
  );
