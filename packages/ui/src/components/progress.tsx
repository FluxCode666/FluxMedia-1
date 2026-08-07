/**
 * shadcn/ui 进度条组件。
 *
 * 使用方：应用内确定进度指标与全站导航反馈。基于 Radix Progress 提供可访问语义，
 * 并允许调用方单独定制轨道和指示条样式。
 */
"use client";

import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as React from "react";
import { cn } from "../utils";

type ProgressProps = React.ComponentPropsWithoutRef<
  typeof ProgressPrimitive.Root
> & {
  indicatorClassName?: string;
};

/** 渲染可访问的 shadcn/ui 进度条，并按 value 平移内部指示条。 */
const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, indicatorClassName, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
      className
    )}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        "h-full w-full flex-1 bg-primary transition-all",
        indicatorClassName
      )}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
