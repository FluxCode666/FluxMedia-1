import { canViewImageBackendPool } from "@repo/shared/auth/roles";
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getServerSession } from "@repo/shared/auth/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { ImageSizeConfigAdminPanel } from "@/features/image-backend-pool/image-size-config-admin-panel";

export default async function DashboardAdminImageSizeConfigsPage() {
  const [session, locale] = await Promise.all([getServerSession(), getLocale()]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  const role = await getUserRoleById(session.user.id);
  if (!canViewImageBackendPool(role)) redirect(`/${locale}/dashboard`);
  return (
    <main className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <h1 className="font-serif text-2xl font-medium tracking-tight">图片尺寸配置</h1>
      <ImageSizeConfigAdminPanel readOnly={role === "observer_admin"} />
    </main>
  );
}
