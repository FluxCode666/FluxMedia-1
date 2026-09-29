"use client";

/**
 * 供应商适配版本历史弹窗。
 *
 * 使用方：供应商账号详情页标题栏。展示该账号的适配版本（后台表单与 agent 的每次
 * 修改都会追加版本），可查看某版本的脱敏配置，并把适配配置回滚到历史版本。回滚
 * 会追加新版本，只影响新任务，并保留当前认证方式与密钥。
 */
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog";
import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";
import { ChevronLeft, ChevronRight, History, Loader2 } from "lucide-react";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type ApiAdapterRollbackResult,
  type ApiAdapterVersionList,
  type ApiAdapterVersionSummary,
  getApiAdapterVersionAction,
  listApiAdapterVersionsAction,
  rollbackApiAdapterAction,
} from "./actions";

/** 等待确认的回滚：目标版本与预演结果。 */
interface PendingRollback {
  version: ApiAdapterVersionSummary;
  preview: ApiAdapterRollbackResult;
}

/**
 * 渲染适配版本历史入口与弹窗。
 *
 * @param memberId 供应商账号 ID。
 * @param readOnly 为 true 时只允许查看，不显示回滚。
 * @param timeZone 当前用户时区。
 * @param onRolledBack 回滚成功后的回调，用于刷新详情页。
 * @returns 触发按钮、版本列表弹窗和回滚确认弹窗。
 * @sideEffects 打开时读取版本列表；确认回滚会写入新版本并记录审计。
 */
export function AdapterVersionHistoryDialog({
  memberId,
  readOnly = false,
  timeZone,
  onRolledBack,
}: {
  memberId: string;
  readOnly?: boolean;
  timeZone?: string;
  onRolledBack?: () => void;
}) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ApiAdapterVersionList | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [viewing, setViewing] = useState<{
    version: ApiAdapterVersionSummary;
    config: string;
  } | null>(null);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRollback | null>(null);
  const [reason, setReason] = useState("");
  const [isRollingBack, setIsRollingBack] = useState(false);

  /** 读取指定页的版本列表。 */
  const loadVersions = useCallback(
    async (targetPage: number) => {
      setIsLoading(true);
      try {
        const result = await listApiAdapterVersionsAction({
          id: memberId,
          page: targetPage,
          pageSize: 10,
        });
        if (result?.data) {
          setList(result.data);
          setPage(result.data.page);
        } else {
          toast.error(result?.serverError || "加载适配版本失败");
        }
      } catch {
        toast.error("加载适配版本失败");
      } finally {
        setIsLoading(false);
      }
    },
    [memberId]
  );

  useEffect(() => {
    if (open) void loadVersions(1);
  }, [loadVersions, open]);

  /** 关闭弹窗时清理查看与回滚状态。 */
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setViewing(null);
      setPending(null);
      setReason("");
    }
  };

  /** 读取并展示某个版本的脱敏配置。 */
  const handleView = async (version: ApiAdapterVersionSummary) => {
    setBusyVersionId(version.id);
    try {
      const result = await getApiAdapterVersionAction({
        id: memberId,
        versionId: version.id,
      });
      if (!result?.data) {
        toast.error(result?.serverError || "读取版本配置失败");
        return;
      }
      setViewing({
        version,
        config: JSON.stringify(result.data.config, null, 2),
      });
    } catch {
      toast.error("读取版本配置失败");
    } finally {
      setBusyVersionId(null);
    }
  };

  /** 预演回滚，确认会变化的字段后再弹出确认。 */
  const handlePrepareRollback = async (version: ApiAdapterVersionSummary) => {
    if (!list) return;
    setBusyVersionId(version.id);
    try {
      const result = await rollbackApiAdapterAction({
        id: memberId,
        versionId: version.id,
        expectedCurrentVersionId: list.currentVersionId,
        dryRun: true,
      });
      if (!result?.data) {
        toast.error(result?.serverError || "预演回滚失败");
        return;
      }
      if (!result.data.changed) {
        toast.info("该版本与当前适配配置一致，无需回滚");
        return;
      }
      setReason("");
      setPending({ version, preview: result.data });
    } catch {
      toast.error("预演回滚失败");
    } finally {
      setBusyVersionId(null);
    }
  };

  /** 执行回滚；版本冲突时刷新列表让管理员重新确认。 */
  const handleConfirmRollback = async () => {
    if (!pending || !list || isRollingBack) return;
    setIsRollingBack(true);
    try {
      const result = await rollbackApiAdapterAction({
        id: memberId,
        versionId: pending.version.id,
        expectedCurrentVersionId: list.currentVersionId,
        reason: reason.trim(),
        dryRun: false,
      });
      if (!result?.data) {
        toast.error(result?.serverError || "回滚失败");
        setPending(null);
        await loadVersions(1);
        return;
      }
      toast.success(
        `已回滚到版本 #${pending.version.revision}，新版本 #${result.data.currentVersion.revision} 对新任务生效`
      );
      setPending(null);
      await loadVersions(1);
      onRolledBack?.();
    } catch {
      toast.error("回滚失败");
    } finally {
      setIsRollingBack(false);
    }
  };

  const formatTime = (value: string) =>
    formatDateInTimeZone(
      value,
      locale,
      { dateStyle: "medium", timeStyle: "short" },
      timeZone
    );

  return (
    <>
      <Dialog onOpenChange={handleOpenChange} open={open}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline">
            <History />
            版本历史
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>适配版本历史</DialogTitle>
            <DialogDescription>
              后台表单和 agent
              的每次适配修改都会生成新版本。回滚会以历史版本的适配配置追加新版本，只影响新任务，并保留当前认证方式与密钥。
            </DialogDescription>
          </DialogHeader>

          {viewing ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  版本 #{viewing.version.revision} 的适配配置
                </p>
                <Button
                  onClick={() => setViewing(null)}
                  size="sm"
                  variant="ghost"
                >
                  <ChevronLeft />
                  返回列表
                </Button>
              </div>
              <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                {viewing.config}
              </pre>
            </section>
          ) : (
            <section className="space-y-3">
              {!list || list.items.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {isLoading ? "正在加载…" : "暂无适配版本"}
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {list.items.map((version) => (
                    <li
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                      key={version.id}
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium tabular-nums">
                            #{version.revision}
                          </span>
                          {version.isCurrent ? (
                            <Badge variant="secondary">当前</Badge>
                          ) : null}
                          <span className="text-xs text-muted-foreground">
                            {formatTime(version.createdAt)}
                          </span>
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {version.baseUrl || "未配置 baseUrl"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          disabled={busyVersionId === version.id}
                          onClick={() => void handleView(version)}
                          size="sm"
                          variant="ghost"
                        >
                          查看配置
                        </Button>
                        {readOnly || version.isCurrent ? null : (
                          <Button
                            disabled={busyVersionId === version.id}
                            onClick={() => void handlePrepareRollback(version)}
                            size="sm"
                            variant="outline"
                          >
                            {busyVersionId === version.id ? (
                              <Loader2 className="animate-spin" />
                            ) : null}
                            回滚到此版本
                          </Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {list && list.totalPages > 1 ? (
                <div className="flex items-center justify-end gap-2 text-sm">
                  <Button
                    disabled={isLoading || page <= 1}
                    onClick={() => void loadVersions(page - 1)}
                    size="sm"
                    variant="ghost"
                  >
                    <ChevronLeft />
                    上一页
                  </Button>
                  <span className="tabular-nums text-muted-foreground">
                    {page} / {list.totalPages}
                  </span>
                  <Button
                    disabled={isLoading || page >= list.totalPages}
                    onClick={() => void loadVersions(page + 1)}
                    size="sm"
                    variant="ghost"
                  >
                    下一页
                    <ChevronRight />
                  </Button>
                </div>
              ) : null}
            </section>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(next) => {
          if (!next && !isRollingBack) setPending(null);
        }}
        open={pending !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>回滚到版本 #{pending?.version.revision}？</DialogTitle>
            <DialogDescription>
              将生成新版本 #{pending?.preview.currentVersion.revision}
              ，只影响之后创建的任务，运行中的任务继续使用原版本。认证方式和密钥保持不变。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">将变化的字段</p>
            <ul className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {pending?.preview.changedFields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="adapter-rollback-reason">回滚原因（可选）</Label>
            <Textarea
              id="adapter-rollback-reason"
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：新响应脚本解析失败，恢复上一版"
              value={reason}
            />
          </div>
          <DialogFooter>
            <Button
              disabled={isRollingBack}
              onClick={() => setPending(null)}
              variant="outline"
            >
              取消
            </Button>
            <Button disabled={isRollingBack} onClick={handleConfirmRollback}>
              {isRollingBack ? <Loader2 className="animate-spin" /> : null}
              确认回滚
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
