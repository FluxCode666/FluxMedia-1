/**
 * 运营总览可复用指标卡。
 *
 * 使用方：顶部增长指标、商业化摘要与系统健康摘要。组件显式显示统计状态、比较值
 * 和口径说明，避免把上线前、无数据或不可比较渲染为普通零值。
 */
import { Badge } from "@repo/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import type { ReactNode } from "react";

import type { OperationsDisplayStatus } from "./operations-dashboard-format";

type OperationsMetricCardProps = {
  title: string;
  value: ReactNode;
  description: string;
  status?: OperationsDisplayStatus;
  statusLabel?: string;
  comparison?: ReactNode;
  action?: ReactNode;
};

/** 渲染一个保留特殊状态、比较和核对入口的只读指标卡。 */
export function OperationsMetricCard({
  title,
  value,
  description,
  status = "value",
  statusLabel,
  comparison,
  action,
}: OperationsMetricCardProps) {
  return (
    <Card className="gap-4 border-[#1C1C1A]/15 bg-[#F0EFEB] py-5 shadow-none">
      <CardHeader className="gap-2 px-5">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm font-semibold text-[#1C1C1A]">
            {title}
          </CardTitle>
          {statusLabel ? (
            <Badge
              className="border-[#1C1C1A]/15 bg-transparent text-[#1C1C1A]"
              variant="outline"
            >
              {statusLabel}
            </Badge>
          ) : null}
        </div>
        <CardDescription className="text-xs leading-relaxed text-[#1C1C1A]/60">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        <div
          className="font-mono text-3xl font-extrabold tabular-nums tracking-tight text-[#1C1C1A]"
          data-status={status}
        >
          {value}
        </div>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2 text-xs text-[#1C1C1A]/65">
          <span>{comparison}</span>
          {action}
        </div>
      </CardContent>
    </Card>
  );
}
