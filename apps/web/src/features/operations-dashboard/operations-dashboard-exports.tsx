/**
 * 运营总览异步 CSV 导出记录与操作区。
 *
 * 使用方：OperationsDashboardPanel。组件创建三类完整导出、手动刷新/翻页记录、重试
 * 失败任务和准备受控下载；不自动轮询，完成通知通过当前管理员本地水位避免重复。
 */
"use client";

import {
  type OperationsDashboardQueryInput,
  type OperationsExportTask,
  type OperationsExportType,
  operationsCreateExportOutputSchema,
  operationsListExportsOutputSchema,
  operationsPrepareExportDownloadOutputSchema,
  operationsRetryExportOutputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { cn } from "@repo/ui/utils";
import {
  Download,
  FileDown,
  Loader2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  createOperationsExportAction,
  listOperationsExportsAction,
  prepareOperationsExportDownloadAction,
  retryOperationsExportAction,
} from "./actions";
import { formatOperationsDateTime } from "./operations-dashboard-format";

type OperationsDashboardExportsProps = {
  currentUserId: string;
  initialTasks: OperationsExportTask[];
  initialNextCursor: string | null;
  initialLoadFailed?: boolean;
  query: OperationsDashboardQueryInput;
};

type ExportAction =
  | { kind: "create"; exportType: OperationsExportType }
  | { kind: "retry" | "download"; taskId: string }
  | { kind: "refresh" | "more" };

const EXPORT_TYPES: OperationsExportType[] = [
  "user_growth",
  "commercialization",
  "content_production",
];

/** 将 Date 或 ISO 输出转换为可排序毫秒；非法值不推进通知水位。 */
function toTimestamp(value: Date | string | null): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** 返回当前列表中最新完成时间。 */
function latestCompletedAt(tasks: readonly OperationsExportTask[]): number {
  return tasks.reduce(
    (latest, task) =>
      task.status === "completed"
        ? Math.max(latest, toTimestamp(task.completedAt))
        : latest,
    0
  );
}

/** 用任务 ID 合并列表并保持创建时间倒序。 */
function mergeTasks(
  current: readonly OperationsExportTask[],
  incoming: readonly OperationsExportTask[]
): OperationsExportTask[] {
  const indexed = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) indexed.set(task.id, task);
  return Array.from(indexed.values()).sort(
    (left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt)
  );
}

/** 创建浏览器可用且服务端有界的导出幂等请求标识。 */
function createClientRequestId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/** 渲染三类异步导出入口、长期记录和完成下载工作流。 */
export function OperationsDashboardExports({
  currentUserId,
  initialTasks,
  initialNextCursor,
  initialLoadFailed = false,
  query,
}: OperationsDashboardExportsProps) {
  const t = useTranslations("OperationsDashboard");
  const locale = useLocale();
  const [tasks, setTasks] = useState(initialTasks);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [activeAction, setActiveAction] = useState<ExportAction | null>(null);
  const [loadFailed, setLoadFailed] = useState(initialLoadFailed);
  const notificationKey = `operations-export-completed:${currentUserId}`;
  const initializedWatermark = useRef(false);

  useEffect(() => {
    if (initializedWatermark.current) return;
    initializedWatermark.current = true;
    const latest = latestCompletedAt(initialTasks);
    if (!localStorage.getItem(notificationKey)) {
      localStorage.setItem(notificationKey, String(latest));
    }
  }, [initialTasks, notificationKey]);

  /** 比较本地已见水位，发现新完成任务时发送一次页面内通知。 */
  function notifyNewCompletions(nextTasks: OperationsExportTask[]): void {
    const previous = Number(localStorage.getItem(notificationKey) ?? "0");
    const latest = latestCompletedAt(nextTasks);
    if (latest > previous) {
      toast.success(t("exports.notifications.completed"));
      localStorage.setItem(notificationKey, String(latest));
    }
  }

  /** 创建指定模块的完整 CSV，任务创建成功后立即进入记录列表。 */
  async function createExport(
    exportType: OperationsExportType,
    exportQuery: OperationsDashboardQueryInput
  ): Promise<void> {
    setActiveAction({ kind: "create", exportType });
    try {
      const result = await createOperationsExportAction({
        exportType,
        query: exportQuery,
        clientRequestId: createClientRequestId("operations-export"),
      });
      const parsed = operationsCreateExportOutputSchema.safeParse(result?.data);
      if (!parsed.success) throw new Error("invalid export response");
      setTasks((current) => mergeTasks(current, [parsed.data.task]));
      toast.success(t("exports.notifications.created"));
    } catch {
      toast.error(t("exports.notifications.createFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  /** 手动刷新第一页；成功时更新状态并检查完成通知。 */
  async function refreshTasks(): Promise<void> {
    setActiveAction({ kind: "refresh" });
    try {
      const result = await listOperationsExportsAction({ limit: 20 });
      const parsed = operationsListExportsOutputSchema.safeParse(result?.data);
      if (!parsed.success) throw new Error("invalid export list");
      setTasks(parsed.data.tasks);
      setNextCursor(parsed.data.nextCursor);
      setLoadFailed(false);
      notifyNewCompletions(parsed.data.tasks);
    } catch {
      setLoadFailed(true);
      toast.error(t("exports.notifications.refreshFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  /** 使用签名 cursor 继续读取更早记录，不替换已经展示的任务。 */
  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setActiveAction({ kind: "more" });
    try {
      const result = await listOperationsExportsAction({
        cursor: nextCursor,
        limit: 20,
      });
      const parsed = operationsListExportsOutputSchema.safeParse(result?.data);
      if (!parsed.success) throw new Error("invalid export list");
      setTasks((current) => mergeTasks(current, parsed.data.tasks));
      setNextCursor(parsed.data.nextCursor);
    } catch {
      toast.error(t("exports.notifications.moreFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  /** 失败任务以原查询创建关联重试任务，原记录保持不变。 */
  async function retryExport(taskId: string): Promise<void> {
    setActiveAction({ kind: "retry", taskId });
    try {
      const result = await retryOperationsExportAction({
        taskId,
        clientRequestId: createClientRequestId("operations-export-retry"),
      });
      const parsed = operationsRetryExportOutputSchema.safeParse(result?.data);
      if (!parsed.success) throw new Error("invalid export retry response");
      setTasks((current) => mergeTasks(current, [parsed.data.task]));
      toast.success(t("exports.notifications.retryCreated"));
    } catch {
      toast.error(t("exports.notifications.retryFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  /** 准备短期许可后使用浏览器下载；页面不持久化签名 URL。 */
  async function downloadExport(taskId: string): Promise<void> {
    setActiveAction({ kind: "download", taskId });
    try {
      const result = await prepareOperationsExportDownloadAction({ taskId });
      const parsed = operationsPrepareExportDownloadOutputSchema.safeParse(
        result?.data
      );
      if (!parsed.success || !parsed.data.downloadUrl) {
        throw new Error("invalid export download response");
      }
      window.location.assign(parsed.data.downloadUrl);
    } catch {
      toast.error(t("exports.notifications.downloadFailed"));
    } finally {
      setActiveAction(null);
    }
  }

  const isBusy = activeAction !== null;
  return (
    <section aria-labelledby="operations-exports-title" className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="gap-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle id="operations-exports-title">
                {t("exports.title")}
              </CardTitle>
              <CardDescription className="mt-1 max-w-3xl">
                {t("exports.description")}
              </CardDescription>
            </div>
            <Button
              disabled={isBusy}
              onClick={() => void refreshTasks()}
              type="button"
              variant="outline"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn(
                  "size-4",
                  activeAction?.kind === "refresh" &&
                    "animate-spin motion-reduce:animate-none"
                )}
              />
              {t("exports.actions.refresh")}
            </Button>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            {EXPORT_TYPES.map((exportType) => (
              <Button
                className="min-h-11 justify-start shadow-none"
                disabled={isBusy}
                key={exportType}
                onClick={() => void createExport(exportType, query)}
                type="button"
                variant="outline"
              >
                {activeAction?.kind === "create" &&
                activeAction.exportType === exportType ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  <FileDown aria-hidden="true" className="size-4" />
                )}
                {t(`exports.types.${exportType}`)}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadFailed ? (
            <p className="text-sm text-destructive" role="alert">
              {t("exports.loadFailed")}
            </p>
          ) : null}
          {tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              {t("exports.empty")}
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => {
                const taskBusy =
                  (activeAction?.kind === "retry" ||
                    activeAction?.kind === "download") &&
                  activeAction.taskId === task.id;
                return (
                  <article
                    className="flex flex-col gap-3 rounded-xl border px-4 py-3 lg:flex-row lg:items-center"
                    key={task.id}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">
                          {t(`exports.types.${task.exportType}`)}
                        </p>
                        <Badge variant="outline">
                          {t(`exports.status.${task.status}`)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatOperationsDateTime(
                          task.createdAt,
                          locale,
                          "UTC"
                        )}
                        {task.rowCount !== null
                          ? ` · ${t("exports.rows", { count: task.rowCount })}`
                          : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {task.status === "completed" ? (
                        <Button
                          disabled={isBusy}
                          onClick={() => void downloadExport(task.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {taskBusy ? (
                            <Loader2
                              aria-hidden="true"
                              className="size-4 animate-spin motion-reduce:animate-none"
                            />
                          ) : (
                            <Download aria-hidden="true" className="size-4" />
                          )}
                          {t("exports.actions.download")}
                        </Button>
                      ) : null}
                      {task.status === "failed" ? (
                        <Button
                          disabled={isBusy}
                          onClick={() => void retryExport(task.id)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {taskBusy ? (
                            <Loader2
                              aria-hidden="true"
                              className="size-4 animate-spin motion-reduce:animate-none"
                            />
                          ) : (
                            <RotateCcw aria-hidden="true" className="size-4" />
                          )}
                          {t("exports.actions.retry")}
                        </Button>
                      ) : null}
                      <Button
                        disabled={isBusy}
                        onClick={() =>
                          void createExport(task.exportType, task.query)
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("exports.actions.regenerate")}
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {nextCursor ? (
            <Button
              className="w-full"
              disabled={isBusy}
              onClick={() => void loadMore()}
              type="button"
              variant="outline"
            >
              {activeAction?.kind === "more" ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {t("exports.actions.more")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
