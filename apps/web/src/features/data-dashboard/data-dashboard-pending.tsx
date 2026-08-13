/**
 * 数据看板首次加载、重试与完整不可用状态。
 *
 * 使用方：用户端与管理端 Panel 在尚无有效快照时渲染。组件不构造零值或空图表，避免把
 * not_ready、timeout、会话过期和服务故障伪装成真实无数据。
 */
"use client";

import { Button } from "@repo/ui/components/button";
import { Card, CardContent } from "@repo/ui/components/card";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/routing";

import type { DataDashboardFailureStatus } from "./data-dashboard-state";

type DataDashboardPendingProps = {
  failureStatus: DataDashboardFailureStatus;
  isLoading: boolean;
  onRetry: () => void;
};

/** 渲染加载或可恢复错误，不暴露服务端异常详情。 */
export function DataDashboardPending({
  failureStatus,
  isLoading,
  onRetry,
}: DataDashboardPendingProps) {
  const t = useTranslations("DataDashboard");
  return (
    <Card>
      <CardContent className="flex min-h-[360px] flex-col items-center justify-center gap-4 px-6 py-12 text-center">
        {isLoading ? (
          <Loader2
            aria-hidden="true"
            className="size-8 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <TriangleAlert
            aria-hidden="true"
            className="size-8 text-muted-foreground"
          />
        )}
        <div className="max-w-md space-y-2">
          <h2 className="font-serif text-xl font-medium">
            {isLoading ? t("state.loadingTitle") : t("state.unavailableTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? t("state.loadingDescription")
              : t(`state.failure.${failureStatus ?? "unavailable"}`)}
          </p>
        </div>
        {!isLoading && failureStatus === "unauthenticated" ? (
          <Button asChild>
            <Link href="/sign-in">{t("actions.signIn")}</Link>
          </Button>
        ) : !isLoading ? (
          <Button onClick={onRetry} type="button">
            <RefreshCw />
            {t("actions.retry")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
