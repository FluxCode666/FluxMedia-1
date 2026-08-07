/** 推广奖励页面服务端会话与时区装配入口。 */

import { normalizeUserRole } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { logError } from "@repo/shared/logger";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { invokeOperation } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import type { ReferralDashboardOutput } from "@/features/referrals/actions";
import { ReferralDashboard } from "@/features/referrals/referral-dashboard";
import { ensureUolInitialized } from "@/server/uol-init";

export default async function ReferralsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const [{ locale }, session] = await Promise.all([params, getServerSession()]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  let initialDashboard: ReferralDashboardOutput | null = null;
  try {
    await ensureUolInitialized();
    initialDashboard = await invokeOperation<ReferralDashboardOutput>(
      "referral.getMyDashboard",
      {},
      {
        type: "user",
        userId: session.user.id,
        role: normalizeUserRole(session.user.role),
      }
    );
  } catch (error) {
    logError(error, {
      source: "referral-dashboard",
      stage: "server-prefetch",
      userId: session.user.id,
    });
  }
  return (
    <ReferralDashboard
      initialDashboard={initialDashboard}
      timeZone={await getUserTimeZone(session.user.id)}
    />
  );
}
