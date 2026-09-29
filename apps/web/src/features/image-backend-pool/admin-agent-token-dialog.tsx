"use client";

/**
 * 管理员 agent 令牌管理弹窗。
 *
 * 使用方：供应商管理页标题栏。管理员在此签发、查看和撤销供外部 agent（如 Claude
 * Code、Codex）调用 /api/admin-agent/v1/* 的令牌。明文令牌只在签发成功后展示一次，
 * 列表只显示前缀和末四位；令牌不能修改供应商认证配置和密钥。
 */
import type { AdminAgentTokenItem } from "@repo/shared/uol/operations/image-backend-pool";
import { formatDateInTimeZone } from "@repo/shared/time-zone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/ui/components/alert-dialog";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Switch } from "@repo/ui/components/switch";
import { Bot, Copy, Loader2, RefreshCw } from "lucide-react";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type CreatedAdminAgentToken,
  createAdminAgentTokenAction,
  listAdminAgentTokensAction,
  revokeAdminAgentTokenAction,
} from "./actions";

const EXPIRY_OPTIONS = ["7", "30", "90"] as const;

const STATUS_LABELS: Record<AdminAgentTokenItem["status"], string> = {
  active: "有效",
  revoked: "已撤销",
  expired: "已过期",
};

/**
 * 按用户时区格式化令牌时间。
 *
 * @param value ISO 时间或 null。
 * @param locale 当前界面语言。
 * @param timeZone 用户 IANA 时区。
 * @returns 可读时间；空值返回"从未"。
 */
function formatTokenTime(
  value: string | null,
  locale: string,
  timeZone?: string
): string {
  if (!value) return "从未";
  return formatDateInTimeZone(
    value,
    locale,
    { dateStyle: "medium", timeStyle: "short" },
    timeZone
  );
}

/**
 * 渲染 agent 令牌管理入口与弹窗。
 *
 * @param timeZone 当前用户时区，用于展示到期和最近使用时间。
 * @returns 触发按钮及令牌管理弹窗。
 * @sideEffects 打开时读取令牌列表；签发和撤销会写入服务端并记录审计。
 */
export function AdminAgentTokenDialog({ timeZone }: { timeZone?: string }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<AdminAgentTokenItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<string>("30");
  const [created, setCreated] = useState<CreatedAdminAgentToken | null>(null);

  /** 重新读取令牌列表。 */
  const loadTokens = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await listAdminAgentTokensAction();
      if (result?.data) {
        setTokens(result.data.tokens);
      } else {
        toast.error(result?.serverError || "加载 agent 令牌失败");
      }
    } catch {
      toast.error("加载 agent 令牌失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadTokens();
  }, [loadTokens, open]);

  /** 关闭弹窗时清除仅展示一次的明文令牌。 */
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setCreated(null);
  };

  /** 签发新令牌；不自动重试，避免重复签发。 */
  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("请填写令牌名称");
      return;
    }
    if (isCreating) return;
    setIsCreating(true);
    try {
      const result = await createAdminAgentTokenAction({
        name: trimmed,
        canWrite,
        expiresInDays: Number(expiresInDays),
      });
      if (!result?.data) {
        toast.error(result?.serverError || "签发 agent 令牌失败");
        return;
      }
      setCreated(result.data);
      setName("");
      setCanWrite(false);
      toast.success("已签发 agent 令牌，请立即复制保存");
      await loadTokens();
    } catch {
      toast.error("签发 agent 令牌失败");
    } finally {
      setIsCreating(false);
    }
  };

  /** 复制仅展示一次的明文令牌。 */
  const handleCopy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      toast.success("已复制令牌");
    } catch {
      toast.error("复制失败，请手动选择文本复制");
    }
  };

  /** 撤销令牌，撤销后立即失效。 */
  const handleRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const result = await revokeAdminAgentTokenAction({ id });
      if (!result?.data) {
        toast.error(result?.serverError || "撤销 agent 令牌失败");
        return;
      }
      if (created?.id === id) setCreated(null);
      toast.success("已撤销 agent 令牌");
      await loadTokens();
    } catch {
      toast.error("撤销 agent 令牌失败");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Bot />
          Agent 令牌
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Agent 令牌</DialogTitle>
          <DialogDescription>
            外部 agent
            使用令牌读取供应商配置、测试和修改请求响应处理脚本。令牌不能修改认证方式和密钥；每次修改都会生成新的适配版本，可在供应商详情中回滚。
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          可写令牌能修改
          baseUrl，上游请求会携带已保存的密钥发往新地址。请只在需要时签发可写令牌，设置较短有效期，并在用完后撤销。
        </div>

        {created ? (
          <section className="space-y-2 rounded-md border bg-muted/30 p-4">
            <p className="text-sm font-medium">
              新令牌「{created.name}」只显示这一次，关闭弹窗后无法再次查看。
            </p>
            <div className="flex gap-2">
              <Input
                aria-label="新签发的 agent 令牌"
                className="font-mono text-xs"
                onFocus={(event) => event.currentTarget.select()}
                readOnly
                value={created.token}
              />
              <Button
                onClick={handleCopy}
                size="sm"
                type="button"
                variant="secondary"
              >
                <Copy />
                复制
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              在 agent 环境中设置
              FLUXMEDIA_ADMIN_AGENT_TOKEN，不要写入代码仓库或聊天记录。
            </p>
          </section>
        ) : null}

        <section className="space-y-3 rounded-md border p-4">
          <h3 className="text-sm font-medium">签发新令牌</h3>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="admin-agent-token-name">名称</Label>
              <Input
                id="admin-agent-token-name"
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Claude Code 调整某供应商脚本"
                value={name}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-agent-token-expiry">有效期</Label>
              <Select onValueChange={setExpiresInDays} value={expiresInDays}>
                <SelectTrigger id="admin-agent-token-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((days) => (
                    <SelectItem key={days} value={days}>
                      {days} 天
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Switch
                checked={canWrite}
                id="admin-agent-token-write"
                onCheckedChange={setCanWrite}
              />
              <Label htmlFor="admin-agent-token-write">
                允许修改和回滚供应商配置
              </Label>
            </div>
            <Button disabled={isCreating} onClick={handleCreate} size="sm">
              {isCreating ? <Loader2 className="animate-spin" /> : null}
              签发
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">已签发令牌</h3>
            <Button
              disabled={isLoading}
              onClick={() => void loadTokens()}
              size="sm"
              variant="ghost"
            >
              <RefreshCw className={isLoading ? "animate-spin" : undefined} />
              刷新
            </Button>
          </div>
          {tokens.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              {isLoading ? "正在加载…" : "还没有签发 agent 令牌"}
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {tokens.map((token) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  key={token.id}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {token.name}
                      </span>
                      <Badge variant={token.canWrite ? "default" : "outline"}>
                        {token.canWrite ? "可写" : "只读"}
                      </Badge>
                      <Badge
                        variant={
                          token.status === "active" ? "secondary" : "outline"
                        }
                      >
                        {STATUS_LABELS[token.status]}
                      </Badge>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {token.tokenPrefix}…{token.lastFour}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {token.isOwn
                        ? null
                        : `签发人 ${token.createdBy.name || token.createdBy.email} · `}
                      到期 {formatTokenTime(token.expiresAt, locale, timeZone)}{" "}
                      · 最近使用{" "}
                      {formatTokenTime(token.lastUsedAt, locale, timeZone)}
                    </p>
                  </div>
                  {token.status === "active" ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          disabled={revokingId === token.id}
                          size="sm"
                          variant="outline"
                        >
                          撤销
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            撤销令牌「{token.name}」？
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            撤销后使用该令牌的 agent
                            会立即无法访问，此操作不可恢复。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>取消</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => void handleRevoke(token.id)}
                          >
                            撤销
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
