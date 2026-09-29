/** 推广看板 Server Action：薄适配真实会话到 UOL。 */
import { protectedAction } from "@repo/shared/safe-action";
import type { referralDashboardOutputSchema } from "@repo/shared/uol/operations/referrals";
import type { z } from "zod";
import { requestGoJson } from "@/lib/go-backend-request";

export type ReferralDashboardOutput = z.infer<
  typeof referralDashboardOutputSchema
>;

export const getMyReferralDashboardAction = protectedAction
  .metadata({ action: "referral.getMyDashboard" })
  .action(async () =>
    requestGoJson<ReferralDashboardOutput>("/api/referrals/dashboard")
  );
