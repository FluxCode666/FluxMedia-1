/**
 * 旧使用日志地址的兼容重定向。
 *
 * 使用日志页面已并入使用记录；保留此无界面路由，避免旧书签和外部回链失效。
 */

import { redirect } from "next/navigation";

/** 将旧地址兼容迁移到当前语言的使用记录页。 */
export default async function LegacyUsageLogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // The locale is already a route parameter. Reading it directly avoids a
  // next-intl request-context lookup during cached server rendering.
  const { locale } = await params;
  redirect(`/${locale}/dashboard/history`);
}
