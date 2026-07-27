/**
 * 共享 Tooltip 组件。
 *
 * 使用方是需要在悬停或键盘聚焦时补充短文本说明的业务界面；基于 Radix UI 保持
 * Portal、延迟、焦点和无障碍语义一致，视觉只使用现有主题 token。
 */
"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import * as React from "react";

import { cn } from "../utils";

/** 为后代 Tooltip 提供统一延迟与跳过延迟配置。 */
const TooltipProvider = TooltipPrimitive.Provider;

/** 管理单个提示层的开关状态。 */
const Tooltip = TooltipPrimitive.Root;

/** 把按钮或文本注册为提示层触发器。 */
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * 渲染主题化提示内容。
 *
 * @param props - Radix Tooltip 内容属性，可覆盖对齐、偏移和样式。
 * @param ref - 指向最终提示内容节点的转发引用。
 * @returns 通过 Portal 渲染且带进入、退出动效的提示层。
 * @sideEffects 打开时在 document.body 下挂载 Portal；关闭时卸载。
 * @failure 缺少 TooltipProvider 时仍由 Radix 管理单个实例，不抛出业务错误。
 */
const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-menu data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=delayed-open]:zoom-in-95",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
