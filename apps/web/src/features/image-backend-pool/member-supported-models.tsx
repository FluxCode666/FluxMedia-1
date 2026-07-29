"use client";

/**
 * 号池成员支持模型的紧凑摘要。
 *
 * 使用方是统一成员账号卡片；组件提供带数量与展开提示的单行摘要，并允许用户点击
 * 展开完整模型集合。文本真实溢出时，Tooltip 继续提供快捷预览。
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/components/tooltip";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

interface HorizontalOverflowMeasurement {
  clientWidth: number;
  scrollWidth: number;
}

export interface MemberSupportedModelsPresentation {
  isEmpty: boolean;
  isExpanded: boolean;
  modelCount: number;
  text: string;
  toggleLabel: string;
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
 * @param isExpanded - 用户是否已展开完整模型集合。
 * @returns 可直接渲染的文本、数量、展开文案与 Tooltip 内容；空集合不启用交互。
 */
export function buildMemberSupportedModelsPresentation(
  modelIds: readonly string[],
  isOverflowing: boolean,
  isExpanded: boolean
): MemberSupportedModelsPresentation {
  if (modelIds.length === 0) {
    return {
      isEmpty: true,
      isExpanded: false,
      modelCount: 0,
      text: "未配置模型",
      toggleLabel: "",
      tooltipText: null,
    };
  }

  const text = modelIds.join("、");
  return {
    isEmpty: false,
    isExpanded,
    modelCount: modelIds.length,
    text,
    toggleLabel: isExpanded ? "收起" : "展开全部",
    tooltipText: isOverflowing && !isExpanded ? text : null,
  };
}

/**
 * 渲染成员支持模型的单行摘要。
 *
 * @param modelIds - 需要展示的完整模型 ID 集合。
 * @returns 带明显点击样式的单行省略摘要；点击后在卡片内展开完整集合。
 * @sideEffects 维护本地展开状态，并订阅摘要尺寸变化以判断是否需要 Tooltip。
 * @failure ResizeObserver 不可用时退化为窗口 resize 监听，不影响文本展示。
 */
export function MemberSupportedModels({
  modelIds,
}: {
  modelIds: readonly string[];
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const detailsId = useId();
  const modelText = modelIds.join("、");
  const presentation = buildMemberSupportedModelsPresentation(
    modelIds,
    isOverflowing,
    isExpanded
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
      <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {presentation.text}
      </p>
    );
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-muted/20">
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-controls={presentation.isExpanded ? detailsId : undefined}
              aria-expanded={presentation.isExpanded}
              aria-label={`${presentation.toggleLabel}支持模型，共 ${presentation.modelCount} 个`}
              className="group flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => setIsExpanded((current) => !current)}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">
                    支持模型
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
                    {presentation.modelCount}
                  </span>
                </span>
                <span
                  ref={textRef}
                  className="mt-1 block w-full truncate font-mono text-xs text-muted-foreground"
                >
                  {presentation.text}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
                {presentation.toggleLabel}
                <ChevronDown
                  aria-hidden="true"
                  className={`size-3.5 transition-transform ${
                    presentation.isExpanded ? "rotate-180" : ""
                  }`}
                />
              </span>
            </button>
          </TooltipTrigger>
          {presentation.tooltipText && (
            <TooltipContent className="max-h-[60vh] max-w-3xl overflow-y-auto whitespace-normal break-all">
              支持的模型：{presentation.tooltipText}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {presentation.isExpanded && (
        <div id={detailsId} className="border-t bg-background/80 px-3 py-3">
          <p className="max-h-96 overflow-y-auto whitespace-normal break-all font-mono text-xs leading-5 text-muted-foreground">
            {presentation.text}
          </p>
        </div>
      )}
    </div>
  );
}
