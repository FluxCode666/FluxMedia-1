/**
 * shadcn/ui 分页基础组件。
 *
 * 使用方：应用内所有页码、keyset 与加载更多导航。支持原生链接以及通过
 * Radix Slot 组合 Next.js/next-intl Link，并统一当前页与禁用态语义。
 */
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../utils";
import { type Button, buttonVariants } from "./button";

/** 渲染带可覆盖无障碍标签的分页导航容器。 */
function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="pagination"
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

/** 渲染分页项目的横向列表。 */
function PaginationContent({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  );
}

/** 渲染单个分页列表项。 */
function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
  asChild?: boolean;
  isActive?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> &
  React.ComponentProps<"a">;

type PaginationDirectionalLinkProps = Omit<
  React.ComponentProps<typeof PaginationLink>,
  "asChild" | "children"
>;

/**
 * 渲染分页链接，或把分页样式和语义组合到框架 Link、button 等子元素。
 *
 * @param props - 当前页、尺寸、组合模式以及标准链接属性。
 * @returns 具备统一焦点、当前页和禁用态样式的分页交互元素。
 */
function PaginationLink({
  asChild = false,
  className,
  isActive,
  size = "icon",
  ...props
}: PaginationLinkProps) {
  const Comp = asChild ? Slot.Root : "a";

  return (
    <Comp
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        "aria-disabled:pointer-events-none aria-disabled:opacity-50",
        buttonVariants({
          variant: isActive ? "outline" : "ghost",
          size,
        }),
        className
      )}
      {...props}
    />
  );
}

/** 渲染 shadcn 默认的上一页链接。 */
function PaginationPrevious({
  className,
  ...props
}: PaginationDirectionalLinkProps) {
  return (
    <PaginationLink
      aria-label="Go to previous page"
      size="default"
      className={cn("gap-1 px-2.5 sm:pl-2.5", className)}
      {...props}
    >
      <ChevronLeftIcon />
      <span className="hidden sm:block">Previous</span>
    </PaginationLink>
  );
}

/** 渲染 shadcn 默认的下一页链接。 */
function PaginationNext({
  className,
  ...props
}: PaginationDirectionalLinkProps) {
  return (
    <PaginationLink
      aria-label="Go to next page"
      size="default"
      className={cn("gap-1 px-2.5 sm:pr-2.5", className)}
      {...props}
    >
      <span className="hidden sm:block">Next</span>
      <ChevronRightIcon />
    </PaginationLink>
  );
}

/** 渲染不可交互的省略页码标记。 */
function PaginationEllipsis({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
};
