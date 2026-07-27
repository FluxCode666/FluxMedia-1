"use client";

/**
 * 支付概览自然月导航器。
 *
 * 使用方：支付概览页。控件只更新白名单 month URL，不读取数据；下一月不能超过
 * 当前报告自然月，避免触发 UOL 的未来范围拒绝。
 */
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { useRouter } from "@/i18n/routing";

import { buildAdminPaymentOverviewHref } from "./admin-payment-query";

type PaymentMonthNavigatorProps = {
  month: string;
  maxMonth: string;
};

/** 将 YYYY-MM 移动指定月数，不依赖浏览器本地时区。 */
function addMonths(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(
    Date.UTC(year ?? 0, (monthNumber ?? 1) - 1 + offset, 1)
  );
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}`;
}

/** 渲染月份输入和前后月图标按钮。 */
export function PaymentMonthNavigator({
  month,
  maxMonth,
}: PaymentMonthNavigatorProps) {
  const t = useTranslations("AdminPayments.overview");
  const router = useRouter();
  const [isNavigating, startTransition] = useTransition();

  /** 导航到指定自然月，UOL 会再次校验未来边界。 */
  function navigate(nextMonth: string): void {
    startTransition(() =>
      router.push(buildAdminPaymentOverviewHref(nextMonth))
    );
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={t("previousMonth")}
              disabled={isNavigating}
              onClick={() => navigate(addMonths(month, -1))}
              size="icon"
              type="button"
              variant="outline"
            >
              <ChevronLeft />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("previousMonth")}</TooltipContent>
        </Tooltip>
        <Input
          aria-label={t("month")}
          className="w-[158px]"
          disabled={isNavigating}
          max={maxMonth}
          onChange={(event) => {
            if (event.target.value) navigate(event.target.value);
          }}
          type="month"
          value={month}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={t("nextMonth")}
              disabled={isNavigating || month >= maxMonth}
              onClick={() => navigate(addMonths(month, 1))}
              size="icon"
              type="button"
              variant="outline"
            >
              <ChevronRight />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("nextMonth")}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
