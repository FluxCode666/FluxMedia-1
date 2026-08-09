"use client";

import { formatCredits } from "@repo/shared/credits/format";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
/** 用户推广看板：展示邀请链接、奖励统计和最近邀请记录。 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Copy, Gift, Loader2, Users } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  getMyReferralDashboardAction,
  type ReferralDashboardOutput,
} from "./actions";

/** 加载并渲染当前用户的推广信息；服务端错误以安全提示降级。 */
export function ReferralDashboard({
  initialDashboard,
  timeZone,
}: {
  initialDashboard: ReferralDashboardOutput | null;
  timeZone: string;
}) {
  const locale = useLocale();
  const t = useTranslations("ReferralDashboard");
  const { execute, result, isPending } = useAction(
    getMyReferralDashboardAction
  );
  useEffect(() => {
    if (!initialDashboard) execute();
  }, [execute, initialDashboard]);
  const dashboard = result.data ?? initialDashboard;

  const copyInviteUrl = async () => {
    if (!dashboard?.inviteUrl || !navigator.clipboard?.writeText) {
      toast.error(t("copyUnsupported"));
      return;
    }
    await navigator.clipboard.writeText(dashboard.inviteUrl);
    toast.success(t("copied"));
  };

  if (isPending && !dashboard) {
    return (
      <div className="flex min-h-64 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    );
  }
  if (!dashboard) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("loadError")}
        </CardContent>
      </Card>
    );
  }
  const inviterReward =
    dashboard.rewardConfig.inviter.mode === "percentage"
      ? t("percentageReward", {
          value: formatCredits(dashboard.rewardConfig.inviter.value),
        })
      : t("fixedReward", {
          value: formatCredits(dashboard.rewardConfig.inviter.value),
        });
  const inviteeReward =
    dashboard.rewardConfig.invitee.mode === "percentage"
      ? t("percentageReward", {
          value: formatCredits(dashboard.rewardConfig.invitee.value),
        })
      : t("fixedReward", {
          value: formatCredits(dashboard.rewardConfig.invitee.value),
        });
  const hasSharedReward =
    dashboard.rewardConfig.inviter.mode ===
      dashboard.rewardConfig.invitee.mode &&
    dashboard.rewardConfig.inviter.value ===
      dashboard.rewardConfig.invitee.value;
  const rewardRule = !dashboard.rewardConfig.enabled
    ? t("rewardDisabled")
    : hasSharedReward
      ? t("sharedRewardRule", { reward: inviterReward })
      : t("splitRewardRule", { inviterReward, inviteeReward });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard
          icon={Users}
          label={t("invited")}
          value={dashboard.invitedCount}
        />
        <MetricCard
          icon={Gift}
          label={t("rewarded")}
          value={dashboard.rewardedCount}
        />
        <MetricCard
          icon={Gift}
          label={t("totalReward")}
          value={formatCredits(dashboard.totalRewardCredits)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("inviteLinkTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={dashboard.inviteUrl} />
            <Button type="button" onClick={copyInviteUrl}>
              <Copy className="mr-2 h-4 w-4" />
              {t("copy")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("codeHint", { code: dashboard.code, rewardRule })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("recent")}</CardTitle>
        </CardHeader>
        <CardContent>
          {dashboard.relationships.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {dashboard.relationships.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {item.inviteeName || item.inviteeEmail}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.inviteeEmail} ·{" "}
                      {formatDateInTimeZone(
                        item.createdAt,
                        locale,
                        { year: "numeric", month: "2-digit", day: "2-digit" },
                        timeZone
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {item.status === "rewarded" ? (
                      <span className="text-sm tabular-nums">
                        +{formatCredits(item.inviterRewardCredits)} Credits
                      </span>
                    ) : null}
                    <Badge
                      variant={
                        item.status === "rewarded" ? "default" : "outline"
                      }
                    >
                      {item.status === "rewarded"
                        ? t("statusRewarded")
                        : item.status === "skipped"
                          ? t("statusSkipped")
                          : t("statusPending")}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <div className="rounded-md bg-muted p-2">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
