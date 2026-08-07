"use client";

/**
 * URL 驱动的分页大小选择器。
 *
 * 使用方：服务端渲染的 keyset、页码与加载更多列表。页面提前构造每个白名单
 * 值对应的安全 URL，本组件仅负责 shadcn 交互和本地化路由导航。
 */
import { PageSizeSelect } from "@repo/ui/components/page-size-select";
import { useTransition } from "react";
import { requestNavigationFeedback } from "@/features/navigation/navigation-feedback-event";
import { useRouter } from "@/i18n/routing";

export type PageSizeHrefOption = {
  size: number;
  href: string;
};

type UrlPageSizeSelectProps = {
  value: number;
  options: PageSizeHrefOption[];
  label: string;
  itemSuffix?: string;
};

/**
 * 选择分页大小后导航到对应首屏 URL。
 *
 * @param props - 当前值、已校验的 size→href 映射与本地化文案。
 * @returns 导航期间禁用的通用分页大小选择器。
 */
export function UrlPageSizeSelect({
  value,
  options,
  label,
  itemSuffix,
}: UrlPageSizeSelectProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <PageSizeSelect
      disabled={isPending}
      itemSuffix={itemSuffix}
      label={label}
      onValueChange={(nextSize) => {
        const option = options.find(({ size }) => size === nextSize);
        if (!option || option.size === value) return;
        startTransition(() => {
          requestNavigationFeedback();
          router.push(option.href);
        });
      }}
      options={options.map(({ size }) => size)}
      value={value}
    />
  );
}
