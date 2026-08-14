/**
 * 运营看板图表的统一 Lieflat Mono 卡片壳。
 *
 * 使用方：本目录六张图。卡片只负责标题、副标题、图、来源行与辅助数据区，
 * 不感知业务数值，也不引入阴影、渐变或额外色系。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import type { ReactNode } from "react";

export type OperationsChartCardProps = {
  title: string;
  description: string;
  source: string;
  action?: ReactNode;
  children: ReactNode;
  accessibility: ReactNode;
};

/**
 * 渲染遵循 Lieflat 四件套的浅色图表卡片。
 *
 * @param props 标题、说明、来源、可选操作区、图形与辅助数据。
 * @returns 无阴影、使用当前主题卡片背景的可访问卡片。
 */
export function OperationsChartCard({
  accessibility,
  action,
  children,
  description,
  source,
  title,
}: OperationsChartCardProps) {
  return (
    <Card className="gap-4 bg-card shadow-none">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-2">
            <CardTitle className="text-base font-bold text-[#1C1C1A]">
              {title}
            </CardTitle>
            <CardDescription className="max-w-3xl text-[#55554F]">
              {description}
            </CardDescription>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {children}
        <p className="text-[0.65rem] font-semibold tracking-[0.16em] text-[#6B6A65] uppercase">
          {source}
        </p>
        {accessibility}
      </CardContent>
    </Card>
  );
}
