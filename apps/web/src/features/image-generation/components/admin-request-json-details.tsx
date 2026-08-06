"use client";

/**
 * 全局使用记录详情中的真实请求 JSON 折叠区。
 *
 * 使用方：图片与视频详情弹层。组件默认折叠，首次展开才调用管理员 UOL Action，
 * 避免列表响应和未查看详情携带较大的请求快照。
 */

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/components/collapsible";
import { CodeBlock } from "@repo/ui/components/code-block";
import { ChevronRight } from "lucide-react";
import { useLocale } from "next-intl";
import { useRef, useState } from "react";

import { getAdminHistoryRequestSnapshotAction } from "../history-actions";

type RequestSnapshotData = NonNullable<
  Awaited<ReturnType<typeof getAdminHistoryRequestSnapshotAction>>["data"]
>;

type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: RequestSnapshotData }
  | { status: "error" };

type AdminRequestJsonDetailsProps = {
  id: string;
  kind: "image" | "video";
};

/**
 * 渲染默认关闭、首次展开懒加载并以两个空格格式化的请求 JSON。
 *
 * @param props 全局历史记录的稳定类型与 ID。
 * @returns 可键盘操作的折叠区；旧记录无快照时显示明确说明。
 * @sideEffects 首次展开时调用一次管理员只读 Action。
 */
export function AdminRequestJsonDetails({
  id,
  kind,
}: AdminRequestJsonDetailsProps) {
  const locale = useLocale();
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);
  const [open, setOpen] = useState(false);
  const [requestState, setRequestState] = useState<RequestState>({
    status: "idle",
  });
  const requestStartedRef = useRef(false);

  /** 首次展开时读取当前记录快照，重复开合复用已完成状态。 */
  function handleOpenChange(nextOpen: boolean): void {
    setOpen(nextOpen);
    if (!nextOpen || requestStartedRef.current) return;
    requestStartedRef.current = true;
    setRequestState({ status: "loading" });
    void getAdminHistoryRequestSnapshotAction({ id, kind })
      .then((result) => {
        if (
          !result.data ||
          result.data.id !== id ||
          result.data.kind !== kind
        ) {
          setRequestState({ status: "error" });
          return;
        }
        setRequestState({ status: "ready", data: result.data });
      })
      .catch(() => {
        setRequestState({ status: "error" });
      });
  }

  const snapshot =
    requestState.status === "ready" ? requestState.data.snapshot : null;
  const formattedJson = snapshot
    ? JSON.stringify(snapshot.body, null, 2)
    : null;

  return (
    <Collapsible onOpenChange={handleOpenChange} open={open}>
      <div className="overflow-hidden rounded-md border border-border bg-muted/20">
        <CollapsibleTrigger asChild>
          <button
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={`size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none ${
                open ? "rotate-90" : ""
              }`}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">
                {copy("Actual request JSON", "实际请求 JSON")}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {copy(
                  "Sensitive values are redacted. Expand to load the saved request body.",
                  "敏感值已脱敏；展开后按需加载已保存的最终请求正文。"
                )}
              </span>
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border px-3 py-3">
            {requestState.status === "loading" ? (
              <p
                aria-live="polite"
                className="text-xs text-muted-foreground"
                role="status"
              >
                {copy("Loading request JSON...", "正在加载请求 JSON...")}
              </p>
            ) : null}
            {requestState.status === "error" ? (
              <p
                className="text-xs leading-relaxed text-destructive"
                role="alert"
              >
                {copy(
                  "Request JSON could not be loaded. Close and reopen the details to retry.",
                  "请求 JSON 加载失败，请关闭并重新打开详情后重试。"
                )}
              </p>
            ) : null}
            {requestState.status === "ready" && !snapshot ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {copy(
                  "No final upstream request was captured for this record. Older records and failures before request-body completion do not have a snapshot.",
                  "该记录未采集到最终上游请求。旧记录以及请求正文完成前的失败不会有快照。"
                )}
              </p>
            ) : null}
            {snapshot && formattedJson ? (
              <CodeBlock
                code={formattedJson}
                labels={{
                  copy: copy("Copy", "复制"),
                  copied: copy("Copied", "已复制"),
                  copyFailed: copy("Copy failed", "复制失败"),
                }}
                language="json"
                showLineNumbers={false}
                title={`${snapshot.operation} · ${snapshot.contentType}`}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
