/**
 * 用户数据看板常规图表的统一卡片结构。
 *
 * 使用方：图片、积分、视频和任务构成图。组件只提供标题、说明、操作区和内容布局，
 * 不感知具体 Recharts 类型或业务数据。
 */
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import type { ReactNode } from "react";

type DashboardChartCardProps = {
  title: string;
  description: string;
  summary: string;
  action?: ReactNode;
  children: ReactNode;
};

/** 渲染与用户端设计系统一致的图表卡片。 */
export function DashboardChartCard({
  title,
  description,
  summary,
  action,
  children,
}: DashboardChartCardProps) {
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="font-serif text-base font-medium tracking-tight">
              {title}
            </CardTitle>
            <CardDescription className="text-xs">{description}</CardDescription>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 py-5">
        {children}
        <p className="text-xs text-muted-foreground">{summary}</p>
      </CardContent>
    </Card>
  );
}
