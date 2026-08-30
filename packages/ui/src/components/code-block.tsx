"use client";

/**
 * 文档与开发者页面共用的代码块。
 *
 * 由业务页面传入纯文本代码，在不引入额外高亮运行时的前提下提供标题、语言标识、
 * 行号、横向滚动和复制反馈；复制失败会显式反馈，不会静默吞掉浏览器权限错误。
 */
import { Check, Clipboard, TriangleAlert } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../utils";
import { Button } from "./button";

type CopyState = "idle" | "copied" | "failed";

// Keep large payloads as one text node. Rendering one React element per line can
// make a modal appear empty while the browser is still mounting thousands of
// spans (request snapshots are intentionally bounded, but can still be large).
const MAX_RENDERED_LINE_ELEMENTS = 500;

type CodeBlockLabels = {
  copy: string;
  copied: string;
  copyFailed: string;
};

export type CodeBlockProps = Omit<ComponentProps<"figure">, "children"> & {
  code: string;
  language?: string;
  title?: string;
  labels?: Partial<CodeBlockLabels>;
  showLineNumbers?: boolean;
};

const DEFAULT_LABELS: CodeBlockLabels = {
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
};

/**
 * 把代码拆成带稳定键和展示序号的行。
 *
 * 相同文本行用出现次数消歧，避免使用数组索引作为 React key；代码变化时不存在需要
 * 保留的行级组件状态，因此重排或增删不会产生错误复用。
 */
function getCodeLines(code: string) {
  const occurrences = new Map<string, number>();
  return code
    .replace(/\n$/, "")
    .split("\n")
    .map((line, index) => {
      const occurrence = (occurrences.get(line) ?? 0) + 1;
      occurrences.set(line, occurrence);
      return {
        key: `${occurrence}-${line}`,
        line,
        lineNumber: index + 1,
      };
    });
}

/**
 * 渲染可访问的代码块。
 *
 * @param props - 代码文本、可选标题/语言、复制文案与 figure 原生属性。
 * @returns 带工具栏、滚动区和屏幕阅读器状态反馈的代码块。
 * @sideEffects 点击复制时写入系统剪贴板，并在两秒后清除临时反馈状态。
 * @failure 浏览器不支持或拒绝 Clipboard API 时展示失败状态并记录控制台错误。
 */
export function CodeBlock({
  code,
  language = "text",
  title,
  labels,
  showLineNumbers = true,
  className,
  ...props
}: CodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const isMountedRef = useRef(false);
  const copyRequestIdRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedLabels = { ...DEFAULT_LABELS, ...labels };
  const lineCount =
    code.length === 0 ? 1 : 1 + (code.match(/\n/g)?.length ?? 0);
  const renderLineElements = lineCount <= MAX_RENDERED_LINE_ELEMENTS;
  const lines = renderLineElements ? getCodeLines(code) : null;

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      copyRequestIdRef.current += 1;

      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, []);

  /**
   * 将完整原始代码复制到剪贴板，并维护成功或失败反馈。
   *
   * @returns 复制与反馈更新完成后解决的 Promise；过期或卸载后的请求直接结束。
   * @sideEffects 写入系统剪贴板、更新 React 状态并管理反馈重置定时器。
   * @failure 当前有效请求被浏览器拒绝时展示失败状态并记录控制台错误。
   */
  const handleCopy = async () => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    const requestId = copyRequestIdRef.current + 1;
    copyRequestIdRef.current = requestId;
    let nextCopyState: Exclude<CopyState, "idle">;
    let copyError: unknown;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable");
      }
      await navigator.clipboard.writeText(code);
      nextCopyState = "copied";
    } catch (error) {
      nextCopyState = "failed";
      copyError = error;
    }

    // Promise 可能逆序完成；仅最后一次且仍挂载的请求可以发布反馈。
    if (!isMountedRef.current || requestId !== copyRequestIdRef.current) {
      return;
    }

    if (nextCopyState === "failed") {
      console.error("Failed to copy code block", copyError);
    }
    setCopyState(nextCopyState);

    const resetTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (isMountedRef.current && requestId === copyRequestIdRef.current) {
        setCopyState("idle");
      }
      if (resetTimerRef.current === resetTimer) {
        resetTimerRef.current = null;
      }
    }, 2000);
    resetTimerRef.current = resetTimer;
  };

  const copyLabel =
    copyState === "copied"
      ? resolvedLabels.copied
      : copyState === "failed"
        ? resolvedLabels.copyFailed
        : resolvedLabels.copy;
  const CopyIcon =
    copyState === "copied"
      ? Check
      : copyState === "failed"
        ? TriangleAlert
        : Clipboard;

  return (
    <figure
      className={cn(
        "min-w-0 max-w-full overflow-hidden rounded-lg border border-border bg-muted/50 shadow-whisper",
        className
      )}
      {...props}
    >
      <div className="flex min-h-10 items-center gap-3 border-b border-border bg-background/70 px-3 py-2">
        <figcaption className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {title || language.toUpperCase()}
        </figcaption>
        {title ? (
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            {language}
          </span>
        ) : null}
        <Button
          aria-label={copyLabel}
          onClick={() => void handleCopy()}
          size="xs"
          type="button"
          variant="ghost"
        >
          <CopyIcon className="size-3" />
          <span className="hidden sm:inline">{copyLabel}</span>
        </Button>
      </div>
      <pre className="max-h-144 min-w-0 max-w-full overflow-auto p-0 font-mono text-xs leading-6 text-foreground">
        <code className="block min-w-0 max-w-full py-3">
          {renderLineElements ? (
            lines?.map((line) => (
              <span
                className={cn(
                  "block min-h-6 whitespace-pre px-4",
                  showLineNumbers &&
                    "grid grid-cols-[2rem_1fr] gap-4 before:select-none before:text-right before:text-muted-foreground/60 before:content-[attr(data-line-number)]"
                )}
                data-line-number={showLineNumbers ? line.lineNumber : undefined}
                key={line.key}
              >
                {line.line || "\u00a0"}
              </span>
            ))
          ) : (
            <span className="block whitespace-pre px-4">{code}</span>
          )}
        </code>
      </pre>
      <span aria-live="polite" className="sr-only">
        {copyState === "idle" ? "" : copyLabel}
      </span>
    </figure>
  );
}
