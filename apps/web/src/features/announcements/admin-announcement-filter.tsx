"use client";

/**
 * 管理公告发布状态 URL 筛选器。
 *
 * 使用方：管理员公告页。选择后通过本地化路由跳转到已由服务端构造的安全 URL，
 * 并由目标 URL 固定清回第一页、保留当前页大小。
 */
import type { AdminAnnouncementPublishedFilter } from "@repo/shared/announcements/list-contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { useTransition } from "react";

import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { useRouter } from "@/i18n/routing";

type AdminAnnouncementFilterOption = {
  value: AdminAnnouncementPublishedFilter;
  label: string;
  href: string;
};

/** 渲染 URL 驱动的公告发布状态筛选。 */
export function AdminAnnouncementFilter({
  value,
  options,
  label,
}: {
  value: AdminAnnouncementPublishedFilter;
  options: AdminAnnouncementFilterOption[];
  label: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Select
      disabled={isPending}
      onValueChange={(nextValue) => {
        const option = options.find((item) => item.value === nextValue);
        if (!option || option.value === value) return;
        startTransition(() => {
          requestNavigationFeedback(option.href);
          router.push(option.href);
        });
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
