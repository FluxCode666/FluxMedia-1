/**
 * 控制台统计暂时不可查询时的安全降级界面。
 *
 * 使用方是 DashboardPage 的可恢复失败分支；只提示用户稍后重试，不展示可能误导的
 * 零值统计。刷新通过当前国际化路由重新请求 Server Component。
 */
import { Button } from "@repo/ui/components/button";
import { Card, CardContent } from "@repo/ui/components/card";
import { ChartNoAxesCombined, Clock3, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTransition } from "react";

import type { DashboardLoadFailureReason } from "@/features/dashboard/dashboard-load-error";
import { useRouter } from "@/i18n/routing";

type DashboardAnalyticsUnavailableProps = {
  isZh: boolean;
  reason: DashboardLoadFailureReason;
  accountSupport?: ReactNode;
};

/** 渲染统计准备或查询超时状态，并允许用户重新发起安全读取。 */
export function DashboardAnalyticsUnavailable({
  isZh,
  reason,
  accountSupport,
}: DashboardAnalyticsUnavailableProps) {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const isTimeout = reason === "query_timeout";
  const isUnavailable = reason === "query_unavailable";
  const StatusIcon = isTimeout || isUnavailable ? Clock3 : ChartNoAxesCombined;

  /** 重新请求当前路由；读模型仍未 ready 时继续保留本界面。 */
  const refresh = () => {
    startTransition(() => router.refresh());
  };

  return (
    <div className="container mx-auto px-4 py-6 md:px-6">
      <div className="space-y-8">
        <header className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
            {copy("Overview", "总览")}
          </p>
          <h1 className="font-serif text-3xl font-medium tracking-tight">
            {copy("Usage overview", "用量概览")}
          </h1>
        </header>

        {accountSupport}

        <Card>
          <CardContent className="flex min-h-[320px] flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mb-5 flex size-12 items-center justify-center rounded-full border bg-muted/35">
              <StatusIcon
                className="size-5 text-muted-foreground"
                strokeWidth={1.5}
              />
            </div>
            <h2 className="font-serif text-xl font-medium tracking-tight">
              {isTimeout
                ? copy("Data query timed out", "数据查询超时")
                : isUnavailable
                  ? copy("Data is temporarily unavailable", "数据暂时不可用")
                  : copy(
                      "Usage analytics are being prepared",
                      "用量统计正在准备中"
                    )}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {isTimeout
                ? copy(
                    "The database did not respond within the expected time. Please try again shortly; your account and usage data are unaffected.",
                    "数据库未能在限定时间内返回结果，请稍后重试。你的账户和用量数据不会受到影响。"
                  )
                : isUnavailable
                  ? copy(
                      "We could not load your account data right now. Please try again shortly.",
                      "当前无法加载你的账户数据，请稍后重试。"
                    )
                  : copy(
                      "Your historical usage is still being processed. No data will be shown until verification is complete.",
                      "历史用量仍在处理和校验中，完成前不会展示可能不准确的数据。"
                    )}
            </p>
            <Button
              className="mt-6"
              disabled={isRefreshing}
              onClick={refresh}
              type="button"
              variant="outline"
            >
              <RefreshCw className={isRefreshing ? "animate-spin" : ""} />
              {isRefreshing
                ? copy("Checking", "正在检查")
                : isTimeout || isUnavailable
                  ? copy("Try again", "重新查询")
                  : copy("Check again", "重新检查")}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
