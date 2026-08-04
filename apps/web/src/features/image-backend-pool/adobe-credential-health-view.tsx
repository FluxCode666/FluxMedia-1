"use client";

/**
 * Adobe direct 成员健康管理视图。
 *
 * 职责：加载单成员安全健康摘要，展示首屏状态和时间，提供立即检查、同账号 Cookie
 * 重新授权，并把 Adobe 诊断保持在默认折叠的纯文本 details 中。使用方是管理员号池面板。
 * 关键边界：只在可写管理员视图挂载；所有写入经 Server Action/UOL，浏览器不接收 Token。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2, RefreshCw, ShieldCheck, Unlock } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  type AdobeCredentialHealthSummary,
  checkAdobeCredentialHealthAction,
  getAdobeCredentialHealthAction,
  reauthorizeAdobeCredentialAction,
} from "./actions";
import {
  formatAdobeHealthTime,
  getAdobeCredentialProfileViews,
  getAdobeHealthDiagnosticEntries,
  getAdobeHealthStatusView,
  getEffectiveAdobeHealthStatus,
} from "./adobe-credential-health-view-model";

/** 展示单个 Adobe direct 成员的健康状态和管理员动作。 */
export function AdobeCredentialHealthView({
  memberId,
  timeZone,
  readOnly,
}: {
  memberId: string;
  timeZone: string;
  readOnly: boolean;
}) {
  const [health, setHealth] = useState<AdobeCredentialHealthSummary | null>(
    null
  );
  const [cookieDraft, setCookieDraft] = useState("");
  const [reauthorizeOpen, setReauthorizeOpen] = useState(false);
  const reauthorizationRequestIdRef = useRef<string | null>(null);

  const { execute: loadHealth, isPending: isLoading } = useAction(
    getAdobeCredentialHealthAction,
    {
      onSuccess: ({ data }) => setHealth(data ?? null),
      onError: ({ error }) =>
        toast.error(error.serverError || "读取 Adobe 凭据健康失败"),
    }
  );
  const { execute: checkHealth, isPending: isChecking } = useAction(
    checkAdobeCredentialHealthAction,
    {
      onSuccess: ({ data }) => {
        if (data) setHealth(data.health);
        toast.success("Adobe 凭据检查已完成");
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "Adobe 凭据检查失败"),
    }
  );
  const { execute: reauthorize, isPending: isReauthorizing } = useAction(
    reauthorizeAdobeCredentialAction,
    {
      onSuccess: ({ data }) => {
        if (data) setHealth(data.health);
        setCookieDraft("");
        setReauthorizeOpen(false);
        reauthorizationRequestIdRef.current = null;
        toast.success("Adobe 凭据已重新授权并恢复健康状态");
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "Adobe 重新授权失败"),
    }
  );

  useEffect(() => {
    if (!readOnly) loadHealth({ memberId });
  }, [loadHealth, memberId, readOnly]);

  if (readOnly) return null;
  const effectiveStatus = health ? getEffectiveAdobeHealthStatus(health) : null;
  const statusView = effectiveStatus
    ? getAdobeHealthStatusView(effectiveStatus)
    : null;
  const profileViews =
    health && effectiveStatus
      ? getAdobeCredentialProfileViews({ ...health, status: effectiveStatus })
      : null;
  const diagnosticEntries = getAdobeHealthDiagnosticEntries(
    health?.diagnostic ?? null
  );
  const busy = isLoading || isChecking || isReauthorizing;

  /** 折叠重新授权表单时同步清除浏览器内存中的 Cookie 草稿。 */
  function toggleReauthorization(): void {
    setReauthorizeOpen((current) => {
      if (current) {
        setCookieDraft("");
        reauthorizationRequestIdRef.current = null;
      }
      return !current;
    });
  }

  /** 使用同一请求 ID 重试未修改的 Cookie，避免网络重放造成重复写入。 */
  function submitReauthorization(): void {
    const clientRequestId =
      reauthorizationRequestIdRef.current ?? crypto.randomUUID();
    reauthorizationRequestIdRef.current = clientRequestId;
    reauthorize({ memberId, cookie: cookieDraft, clientRequestId });
  }

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <ShieldCheck className="size-4 text-muted-foreground" />
          账号凭据状态
          {statusView ? (
            <Badge variant={statusView.variant}>{statusView.label}</Badge>
          ) : (
            <Badge variant="outline">读取中</Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={
              statusView?.primaryAction === "check" ? "default" : "outline"
            }
            disabled={busy}
            onClick={() => checkHealth({ memberId })}
          >
            {isChecking ? (
              <Loader2 className="mr-1 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 size-4" />
            )}
            立即检查
          </Button>
          <Button
            type="button"
            size="sm"
            variant={
              statusView?.primaryAction === "reauthorize"
                ? "default"
                : "outline"
            }
            disabled={busy}
            onClick={toggleReauthorization}
          >
            <Unlock className="mr-1 size-4" />
            重新授权
          </Button>
        </div>
      </div>

      {statusView ? (
        <p className="text-xs text-muted-foreground">
          {statusView.description}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {isLoading ? "正在读取健康摘要…" : "暂时无法读取健康摘要"}
        </p>
      )}

      {health ? (
        <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
          <span>Express 凭据：{profileViews?.express}</span>
          <span>Firefly 凭据：{profileViews?.firefly}</span>
          <span>连续失败：{health.consecutiveFailures}</span>
          <span>
            失败 Profile：
            {health.failureProfiles.length > 0
              ? health.failureProfiles.join("、")
              : "无"}
          </span>
          <span>
            上次检查：{formatAdobeHealthTime(health.lastCheckedAt, timeZone)}
          </span>
          <span>
            最近成功：{formatAdobeHealthTime(health.lastSuccessAt, timeZone)}
          </span>
          <span>
            下次检查：{formatAdobeHealthTime(health.nextCheckAt, timeZone)}
          </span>
        </div>
      ) : null}

      {reauthorizeOpen ? (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <label
            htmlFor={`adobe-reauthorize-cookie-${memberId}`}
            className="text-sm font-medium"
          >
            粘贴新的 Adobe Cookie
          </label>
          <Textarea
            id={`adobe-reauthorize-cookie-${memberId}`}
            rows={4}
            value={cookieDraft}
            onChange={(event) => {
              setCookieDraft(event.target.value);
              reauthorizationRequestIdRef.current = null;
            }}
            placeholder="可粘贴插件导出的 Cookie 字符串或 JSON"
            autoComplete="off"
            disabled={isReauthorizing}
          />
          <p className="text-xs text-muted-foreground">
            系统只验证并保存 Cookie，不保存账号密码；必须与当前稳定 Adobe
            账号一致。
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={isReauthorizing || !cookieDraft.trim()}
              onClick={submitReauthorization}
            >
              {isReauthorizing ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : null}
              提交重新授权
            </Button>
          </div>
        </div>
      ) : null}

      {diagnosticEntries.length > 0 ? (
        <details className="rounded-md border p-2 text-xs">
          <summary className="cursor-pointer font-medium">
            查看 Adobe 原始错误摘要（默认折叠）
          </summary>
          <dl className="mt-2 grid gap-1 sm:grid-cols-2">
            {diagnosticEntries.map((entry) => (
              <div key={entry.label} className="min-w-0">
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd className="break-words">{entry.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}
