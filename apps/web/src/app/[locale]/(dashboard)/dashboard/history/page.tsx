/**
 * 当前用户的图片与视频统一使用记录页。
 *
 * 页面只把公开 URL 状态交给本人历史 UOL Action，并组合用户时区；查询、归属、
 * 日期边界、错误脱敏和 keyset cursor 均由接口层负责。
 */

import { getCurrentUser } from "@repo/shared/auth/server";
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
import { getMyHistoryRecordsAction } from "@/features/image-generation/history-actions";
import { loadPaginationConfig } from "@/features/pagination/server";
import { Link } from "@/i18n/routing";

export const metadata = {
  title: "Usage records | FluxMedia",
  description: "Review and filter your image and video usage records.",
};

type HistoryPageProps = {
  searchParams: Promise<HistorySearchParams>;
};

/** 渲染 URL 驱动的本人图片/视频使用记录。 */
export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const [user, locale, rawSearchParams, paginationConfig] = await Promise.all([
    getCurrentUser(),
    getLocale(),
    searchParams,
    loadPaginationConfig(),
  ]);
  if (!user) redirect(`/${locale}/sign-in`);

  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const queryState = parseHistorySearchParams(rawSearchParams, {
    paginationConfig,
  });
  const retryHref = buildHistoryHref(queryState);
  const [historyResult, timeZoneResult] = await Promise.allSettled([
    getMyHistoryRecordsAction({
      createdFrom: queryState.createdFrom,
      createdTo: queryState.createdTo,
      cursor: queryState.cursor,
      model: queryState.model,
      page: queryState.page,
      pageSize: queryState.pageSize,
      status: queryState.status,
      type: queryState.type,
    }),
    getUserTimeZone(user.id),
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
          {copy("Usage records", "使用记录")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy(
            "Filter image and video generations, including processing and failed records.",
            "筛选图片与视频生成记录，包括处理中和失败的任务。"
          )}
        </p>
      </header>

      {historyData ? (
        <HistoryClient
          key={retryHref}
          modelOptions={historyData.modelOptions}
          nextCursor={historyData.nextCursor}
          page={historyData.page}
          pageSizeOptions={paginationConfig.pageSizeOptions}
          previousCursor={historyData.previousCursor}
          queryState={queryState}
          records={historyData.records}
          timeZone={timeZone}
          totalCount={historyData.totalCount}
        />
      ) : (
        <div className="space-y-4">
          <HistoryFilters modelOptions={[]} state={queryState} />
          <section
            aria-live="assertive"
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"
            role="alert"
          >
            <h2 className="font-serif text-xl font-medium">
              {copy("Usage records could not be loaded", "使用记录加载失败")}
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
