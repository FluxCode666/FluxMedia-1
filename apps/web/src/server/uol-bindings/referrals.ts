/** 用户推广看板 UOL 真实绑定；身份仅从 Principal 派生。 */
import {
  fulfillReferralFirstPayment,
  getReferralDashboard,
} from "@repo/shared/referrals";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { bindOperationExecute, OperationError } from "@repo/shared/uol";
import {
  fulfillAlipayReferralFirstPayment,
  fulfillCreemReferralFirstPayment,
  fulfillEpayReferralFirstPayment,
  getMyReferralDashboard,
} from "@repo/shared/uol/operations/referrals";

bindOperationExecute(getMyReferralDashboard, async (_input, principal) => {
  if (principal.type !== "user") {
    throw new OperationError(
      "unauthenticated",
      "User session authentication required"
    );
  }
  const appUrl =
    (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000";
  return getReferralDashboard({ userId: principal.userId, appUrl });
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
