"use client";

/**
 * 号池成员支持模型的紧凑摘要。
 *
 * 使用方是统一成员账号卡片；组件把完整模型集合限制为单行，并仅在文本真实溢出时
 * 通过共享 Tooltip 向悬浮和键盘聚焦用户提供完整内容。
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { useEffect, useRef, useState } from "react";

interface HorizontalOverflowMeasurement {
  clientWidth: number;
  scrollWidth: number;
}

export interface MemberSupportedModelsPresentation {
  isEmpty: boolean;
  isFocusable: boolean;
  text: string;
  tooltipText: string | null;
}

/**
 * 判断单行模型摘要是否真实发生横向溢出。
 *
 * @param measurement - 浏览器提供的可见宽度与完整内容宽度。
 * @returns 仅在元素已获得有效宽度且完整内容更宽时返回 true。
 */
export function isMemberSupportedModelsOverflowing(
  measurement: HorizontalOverflowMeasurement
): boolean {
  return (
    measurement.clientWidth > 0 &&
    measurement.scrollWidth > measurement.clientWidth
  );
}

/**
 * 构造模型摘要的显示与辅助交互状态。
 *
 * @param modelIds - 成员声明的完整模型 ID 集合，保留上游顺序。
 * @param isOverflowing - 当前单行文本是否被裁切。
 * @returns 可直接渲染的文本、Tooltip 内容与焦点状态；空集合不启用 Tooltip。
 */
export function buildMemberSupportedModelsPresentation(
  modelIds: readonly string[],
  isOverflowing: boolean
): MemberSupportedModelsPresentation {
  if (modelIds.length === 0) {
    return {
      isEmpty: true,
      isFocusable: false,
      text: "未配置模型",
      tooltipText: null,
    };
  }

  const text = modelIds.join("、");
  return {
    isEmpty: false,
    isFocusable: isOverflowing,
    text,
    tooltipText: isOverflowing ? text : null,
  };
}

/**
 * 渲染成员支持模型的单行摘要。
 *
 * @param modelIds - 需要展示的完整模型 ID 集合。
 * @returns 单行省略文本；仅溢出时可悬浮或聚焦查看完整集合。
 * @sideEffects 订阅摘要元素尺寸变化以重新判断是否需要 Tooltip。
 * @failure ResizeObserver 不可用时退化为窗口 resize 监听，不影响文本展示。
 */
export function MemberSupportedModels({
  modelIds,
}: {
  modelIds: readonly string[];
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const modelText = modelIds.join("、");
  const presentation = buildMemberSupportedModelsPresentation(
    modelIds,
    isOverflowing
  );

  useEffect(() => {
    const element = textRef.current;
    if (!element || modelText.length === 0) {
      setIsOverflowing(false);
      return;
    }

    const updateOverflow = (): void => {
      setIsOverflowing(
        isMemberSupportedModelsOverflowing({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        })
      );
    };

    updateOverflow();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [modelText]);

  if (presentation.isEmpty) {
    return (
      <p className="truncate text-xs text-muted-foreground">
        {presentation.text}
      </p>
    );
  }

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            ref={textRef}
            className={`block w-full truncate rounded-sm font-mono text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              presentation.isFocusable ? "cursor-help" : ""
            }`}
            tabIndex={presentation.isFocusable ? 0 : undefined}
          >
            {presentation.text}
          </span>
        </TooltipTrigger>
        {presentation.tooltipText && (
          <TooltipContent className="max-h-[60vh] max-w-3xl overflow-y-auto whitespace-normal break-all">
            支持的模型：{presentation.tooltipText}
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}
