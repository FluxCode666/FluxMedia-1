/**
 * 管理端全局图片与视频使用记录页。
 *
 * 页面只解析公开 URL 状态、复查人工管理员角色，并调用管理员历史 UOL Action；全局
 * 数据作用域、用户邮箱筛选、cursor 绑定与字段脱敏均在统一接口层处理。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { canViewGlobalUsageRecords } from "@repo/shared/auth/roles";
import { getServerSession } from "@repo/shared/auth/server";
import { getAppTimeZone, getUserTimeZone } from "@repo/shared/time-zone/server";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

import { HistoryClient } from "@/features/image-generation/components/history-client";
import { HistoryFilters } from "@/features/image-generation/components/history-filters";
import {
  buildHistoryHref,
  type HistorySearchParams,
  parseHistorySearchParams,
} from "@/features/image-generation/components/history-query";
import { getAdminHistoryRecordsAction } from "@/features/image-generation/history-actions";
import { Link } from "@/i18n/routing";

export const metadata = {
  title: "Global usage records | FluxMedia",
  description:
    "Review and filter image and video generation records across FluxMedia.",
};

type AdminHistoryPageProps = {
  searchParams: Promise<HistorySearchParams>;
};

/** 渲染 URL 驱动、仅人工管理员可见的全局图片/视频使用记录。 */
export default async function DashboardAdminHistoryPage({
  searchParams,
}: AdminHistoryPageProps) {
  const [session, locale, rawSearchParams] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);

  const role = await getUserRoleById(session.user.id);
  if (!canViewGlobalUsageRecords(role)) redirect(`/${locale}/dashboard`);

  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const queryState = parseHistorySearchParams(rawSearchParams, {
    allowUserEmail: true,
  });
  const historyPath = "/dashboard/admin/history";
  const retryHref = buildHistoryHref(queryState, { path: historyPath });
  const [historyResult, timeZoneResult] = await Promise.allSettled([
    getAdminHistoryRecordsAction({
      createdFrom: queryState.createdFrom,
      createdTo: queryState.createdTo,
      cursor: queryState.cursor,
      limit: 20,
      model: queryState.model,
      status: queryState.status,
      type: queryState.type,
      userEmail: queryState.userEmail,
    }),
    getUserTimeZone(session.user.id),
  ]);
  const timeZone =
    timeZoneResult.status === "fulfilled"
      ? timeZoneResult.value
      : getAppTimeZone();
  const historyActionResult =
    historyResult.status === "fulfilled" ? historyResult.value : null;
  const historyData = historyActionResult?.data;

  return (
    <div className="container mx-auto space-y-6 px-4 py-6 md:px-6">
      <header>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy("Global usage records", "全局使用记录")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy(
            "Review image and video generations across the system, including their user and supplier account identity.",
            "查看系统中的图片与视频生成记录，并按所属用户及供应商账号名称、ID 追溯。"
          )}
        </p>
      </header>

      {historyData ? (
        <HistoryClient
          canDeleteImages={false}
          historyPath={historyPath}
          modelOptions={historyData.modelOptions}
          nextCursor={historyData.nextCursor}
          previousCursor={historyData.previousCursor}
          queryState={queryState}
          records={historyData.records}
          showUserColumns
          timeZone={timeZone}
          userOptions={historyData.userOptions}
        />
      ) : (
        <div className="space-y-4">
          <HistoryFilters
            historyPath={historyPath}
            modelOptions={[]}
            showUserEmailFilter
            state={queryState}
            userOptions={[]}
          />
          <section
            aria-live="assertive"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"
            role="alert"
          >
            <h2 className="font-serif text-xl font-medium">
              {copy(
                "Global usage records could not be loaded",
                "全局使用记录加载失败"
              )}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {copy(
                "Check the filter values and try again.",
                "请检查筛选条件后重试。"
              )}
            </p>
            <Link
              className="mt-4 inline-block text-sm font-medium underline"
              href={retryHref}
            >
              {copy("Retry", "重试")}
            </Link>
          </section>
        </div>
      )}
    </div>
  );
}
