import {
  canManageUserPermissions,
  normalizeUserRole,
} from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { SystemUpdatesPanel } from "@/features/system-updates/system-updates-panel";

export const dynamic = "force-dynamic";

export default async function SystemUpdatesPage() {
  const [session, locale] = await Promise.all([
    getServerSession(),
    getLocale(),
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  if (session.user.banned) redirect(`/${locale}/dashboard`);
  if (!canManageUserPermissions(normalizeUserRole(session.user.role))) {
    redirect(`/${locale}/dashboard`);
  }

  return <SystemUpdatesPanel />;
}
