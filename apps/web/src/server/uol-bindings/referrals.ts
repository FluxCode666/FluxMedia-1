/** 用户推广看板 UOL 真实绑定；身份仅从 Principal 派生。 */
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import { fulfillReferralFirstPayment } from "@repo/shared/referrals";
import {
  fulfillAlipayReferralFirstPayment,
  fulfillCreemReferralFirstPayment,
  fulfillEpayReferralFirstPayment,
  getMyReferralDashboard,
  listMyReferralRelationships,
} from "@repo/shared/uol/operations/referrals";
import { requestGoJson } from "@/server/go-backend-client";

import type { ReferralRelationshipListOutput } from "@repo/shared/referrals/relationship-contract";

bindOperationExecute(getMyReferralDashboard, async (_input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  // Referral dashboard reads are served by the Go backend so the production
  // data path no longer reaches the Next.js database service.
  return requestGoJson("/api/referrals/dashboard");
});

bindOperationExecute(listMyReferralRelationships, async (input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  // The Go endpoint derives the user from the forwarded session cookie and
  // intentionally accepts no user id or pagination parameters.
  void input;
  return requestGoJson<ReferralRelationshipListOutput>(
    "/api/referrals/relationships"
  );
});

for (const [definition, provider] of [
  [fulfillAlipayReferralFirstPayment, "alipay_f2f"],
  [fulfillEpayReferralFirstPayment, "epay"],
  [fulfillCreemReferralFirstPayment, "creem"],
] as const) {
  bindOperationExecute(definition, async (input) =>
    fulfillReferralFirstPayment({
      ...input,
      paymentProvider: provider,
    })
  );
}
