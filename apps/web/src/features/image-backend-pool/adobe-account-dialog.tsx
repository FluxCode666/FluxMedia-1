"use client";

/**
 * Adobe direct 子账号管理弹窗。
 *
 * 职责：只在 `adobe + direct` 统一成员下展示脱敏账号、导入 Cookie、启停和删除
 * 子账号。Cookie 仅提交给 UOL，成功响应和本地状态都不保留其明文。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Switch } from "@repo/ui/components/switch";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type AdobeAccountAdminSummary,
  deleteAdobeAccountAction,
  importAdobeAccountAction,
  listAdobeAccountsAction,
  setAdobeAccountEnabledAction,
} from "./actions";
import type { BackendMemberAdminSummary } from "./member-service";

/** 格式化 Adobe 余额；未知值显示短横线。 */
function formatCredits(value: number | null): string {
  return typeof value === "number" ? value.toLocaleString("zh-CN") : "—";
}

/** 渲染一个 Adobe direct 成员的内部账号管理界面。 */
export function AdobeAccountDialog({
  open,
  onOpenChange,
  member,
  readOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: BackendMemberAdminSummary | null;
  readOnly: boolean;
}) {
  const [accounts, setAccounts] = useState<AdobeAccountAdminSummary[]>([]);
  const [name, setName] = useState("");
  const [cookie, setCookie] = useState("");

  const { execute: loadAccounts, isPending: isLoading } = useAction(
    listAdobeAccountsAction,
    {
      onSuccess: ({ data }) => setAccounts(data?.accounts ?? []),
      onError: ({ error }) =>
        toast.error(error.serverError || "加载 Adobe 账号失败"),
    }
  );
  const { execute: importAccount, isPending: isImporting } = useAction(
    importAdobeAccountAction,
    {
      onSuccess: () => {
        toast.success("Adobe 账号已导入");
        setCookie("");
        setName("");
        if (member) loadAccounts({ memberId: member.id });
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "导入 Adobe 账号失败"),
    }
  );
  const { execute: deleteAccount, isPending: isDeleting } = useAction(
    deleteAdobeAccountAction,
    {
      onSuccess: () => {
        toast.success("Adobe 账号已删除");
        if (member) loadAccounts({ memberId: member.id });
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "删除 Adobe 账号失败"),
    }
  );
  const { execute: setEnabled, isPending: isSettingEnabled } = useAction(
    setAdobeAccountEnabledAction,
    {
      onSuccess: () => {
        if (member) loadAccounts({ memberId: member.id });
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "更新 Adobe 账号失败"),
    }
  );

  useEffect(() => {
    if (open && member) loadAccounts({ memberId: member.id });
  }, [loadAccounts, member, open]);

  /** 提交一次 Cookie 导入；明文只存在于当前输入与网络请求。 */
  function handleImport(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!member || !cookie.trim()) return;
    importAccount({
      memberId: member.id,
      cookie,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Adobe Direct 账号</DialogTitle>
          <DialogDescription>
            {member?.name ?? "未选择成员"} 的内部 Cookie 与短期 token
            子池。页面永不回显凭据。
          </DialogDescription>
        </DialogHeader>

        {!readOnly && member && (
          <form
            className="space-y-3 rounded-md border p-4"
            onSubmit={handleImport}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="adobe-account-name">账号备注</Label>
                <Input
                  id="adobe-account-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="可选"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adobe-account-cookie">Adobe Cookie</Label>
              <Textarea
                id="adobe-account-cookie"
                value={cookie}
                onChange={(event) => setCookie(event.target.value)}
                rows={5}
                autoComplete="off"
                required
              />
            </div>
            <Button type="submit" disabled={isImporting}>
              {isImporting && <Loader2 className="size-4 animate-spin" />}
              验证并导入
            </Button>
          </form>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">账号列表</h3>
            <p className="text-xs text-muted-foreground">
              {accounts.length} 个账号
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!member || isLoading}
            onClick={() => member && loadAccounts({ memberId: member.id })}
          >
            <RefreshCw
              className={isLoading ? "size-4 animate-spin" : "size-4"}
            />
            刷新
          </Button>
        </div>

        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="rounded-md border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">
                      {account.displayName || account.name || "未命名账号"}
                    </p>
                    <Badge
                      variant={
                        account.status === "active"
                          ? "secondary"
                          : "destructive"
                      }
                    >
                      {account.status}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {account.email || "未获取邮箱"}
                  </p>
                  {account.lastRefreshError && (
                    <p className="text-xs text-destructive">
                      {account.lastRefreshError}
                    </p>
                  )}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={account.isEnabled}
                      disabled={isSettingEnabled}
                      aria-label="启停 Adobe 账号"
                      onCheckedChange={(isEnabled) =>
                        setEnabled({ id: account.id, isEnabled })
                      }
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={isDeleting}
                      onClick={() => {
                        if (
                          window.confirm("确认删除这个 Adobe 账号及其 token？")
                        ) {
                          deleteAccount({ id: account.id });
                        }
                      }}
                    >
                      <Trash2 className="size-4" />
                      <span className="sr-only">删除账号</span>
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <span>总额度 {formatCredits(account.creditsTotal)}</span>
                <span>已使用 {formatCredits(account.creditsUsed)}</span>
                <span>可用 {formatCredits(account.creditsAvailable)}</span>
              </div>
            </div>
          ))}
          {!isLoading && accounts.length === 0 && (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              尚未导入 Adobe 账号。
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
