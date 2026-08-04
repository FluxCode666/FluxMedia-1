"use client";

/**
 * Adobe 凭据通知设置卡片。
 *
 * 职责：在系统设置页配置邮件收件人和 Webhook 地址，展示部署 HMAC 状态、渠道完整性
 * 与脱敏 outbox 摘要。完整 Webhook URL 只在提交时输入，不从服务端回显。
 * 使用方：管理员设置页的系统设置页签；写操作由专用 super-admin Server Action 保护。
 */
import type { AdobeCredentialNotificationSettings } from "@repo/shared/system-settings/adobe-credential-notification-contract";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2, Save, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getAdobeCredentialNotificationSettingsAction,
  setAdobeCredentialNotificationSettingsAction,
} from "./adobe-credential-notification-actions";

/** 把接口返回的收件人列表转换为便于编辑的多行文本。 */
function recipientsToDraft(recipients: string[]): string {
  return recipients.join("\n");
}

/** 兼容逗号、分号和换行的管理员输入并去重。 */
function parseRecipientsDraft(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,;]+/u)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

/** 格式化脱敏投递时间；无时间或非法值显示短横线。 */
function formatDeliveryTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}

/** 展示单渠道配置和 outbox 摘要。 */
function ChannelStatus({
  label,
  configured,
  summary,
}: {
  label: string;
  configured: boolean;
  summary: AdobeCredentialNotificationSettings["deliveryStatus"]["email"];
}) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        <Badge variant={configured ? "secondary" : "outline"}>
          {configured ? "已配置" : "未配置"}
        </Badge>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <span>待投递：{summary.pending}</span>
        <span>重试中：{summary.retrying}</span>
        <span>最终失败：{summary.failed}</span>
        <span>最近成功：{formatDeliveryTime(summary.lastDeliveredAt)}</span>
      </div>
    </div>
  );
}

/**
 * 渲染通知设置模块。
 *
 * @param disabled - 系统设置页整体忙碌时禁用写入控件。
 * @returns 配置表单与脱敏渠道状态卡。
 * @sideEffects 调用读取/写入 Server Action；写入成功后只更新本地安全 DTO。
 * @failure 加载或保存失败时显示可重试错误，不清空管理员当前草稿。
 */
export function AdobeCredentialNotificationSettingsCard({
  disabled,
}: {
  disabled: boolean;
}) {
  const [settings, setSettings] =
    useState<AdobeCredentialNotificationSettings | null>(null);
  const [recipientsDraft, setRecipientsDraft] = useState("");
  const [webhookDraft, setWebhookDraft] = useState("");
  const [webhookTouched, setWebhookTouched] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const applySettings = useCallback(
    (next: AdobeCredentialNotificationSettings) => {
      setSettings(next);
      setRecipientsDraft(recipientsToDraft(next.emailRecipients));
      setWebhookDraft("");
      setWebhookTouched(false);
    },
    []
  );

  const { execute: load, isPending: isLoading } = useAction(
    getAdobeCredentialNotificationSettingsAction,
    {
      onSuccess: ({ data }) => {
        if (data) applySettings(data);
        setLoadError(null);
      },
      onError: ({ error }) =>
        setLoadError(error.serverError || "通知配置加载失败，请重试"),
    }
  );
  const { execute: save, isPending: isSaving } = useAction(
    setAdobeCredentialNotificationSettingsAction,
    {
      onSuccess: ({ data }) => {
        if (data) applySettings(data);
        toast.success("Adobe 凭据通知设置已保存");
      },
      onError: ({ error }) =>
        toast.error(error.serverError || "Adobe 凭据通知设置保存失败"),
    }
  );

  useEffect(() => {
    load();
  }, [load]);

  // WHY：首次读取失败时草稿为空，禁止保存可避免误清空已有收件人或 Webhook。
  const isBusy = disabled || isLoading || isSaving || settings === null;

  function submit(): void {
    const emailRecipients = parseRecipientsDraft(recipientsDraft);
    save({
      emailRecipients,
      ...(webhookTouched ? { webhookUrl: webhookDraft.trim() } : {}),
    });
  }

  return (
    <Card className="rounded-lg">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">Adobe 凭据通知</CardTitle>
          <Badge variant="outline">专用配置</Badge>
        </div>
        <CardDescription>
          邮件渠道需同时配置供应商和收件人；Webhook 渠道需同时配置公网 HTTPS
          地址与部署 HMAC。两个渠道独立启用，HMAC 明文不会在页面显示或修改。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <span role="alert">{loadError}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => load()}
            >
              重试
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="adobe-alert-recipients">告警邮件收件人</Label>
            <Textarea
              id="adobe-alert-recipients"
              value={recipientsDraft}
              onChange={(event) => setRecipientsDraft(event.target.value)}
              placeholder="ops@example.com\nadmin@example.com"
              rows={4}
              disabled={isBusy}
              aria-describedby="adobe-alert-recipients-help"
            />
            <p
              id="adobe-alert-recipients-help"
              className="text-xs text-muted-foreground"
            >
              支持一行一个，也支持逗号或分号分隔；留空将停用邮件告警。
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="adobe-alert-webhook">Webhook 公网 HTTPS 地址</Label>
            <Input
              id="adobe-alert-webhook"
              type="url"
              value={webhookDraft}
              onChange={(event) => {
                setWebhookDraft(event.target.value);
                setWebhookTouched(true);
              }}
              placeholder={
                settings?.webhookHost
                  ? `当前主机 ${settings.webhookHost}；填写新地址以替换`
                  : "https://hooks.example.com/adobe"
              }
              disabled={isBusy}
              aria-describedby="adobe-alert-webhook-help"
            />
            <p
              id="adobe-alert-webhook-help"
              className="text-xs text-muted-foreground"
            >
              不允许
              query、fragment、userinfo、重定向或内网地址；不编辑会保留现有地址。
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge
                variant={
                  settings?.webhookHmacConfigured ? "secondary" : "outline"
                }
              >
                HMAC：{settings?.webhookHmacConfigured ? "已配置" : "未配置"}
              </Badge>
              {settings?.webhookHost ? (
                <span className="text-muted-foreground">
                  当前主机：{settings.webhookHost}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy || !settings?.webhookHost}
                onClick={() => {
                  setWebhookDraft("");
                  setWebhookTouched(true);
                }}
              >
                <Trash2 className="mr-1 size-3" />
                停用 Webhook
              </Button>
              {webhookTouched && !webhookDraft.trim() ? (
                <span className="text-destructive">保存后将停用</span>
              ) : null}
            </div>
          </div>
        </div>

        {settings ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <ChannelStatus
              label="邮件渠道"
              configured={settings.emailConfigured}
              summary={settings.deliveryStatus.email}
            />
            <ChannelStatus
              label="Webhook 渠道"
              configured={settings.webhookConfigured}
              summary={settings.deliveryStatus.webhook}
            />
          </div>
        ) : isLoading ? (
          <div
            className="rounded-md border border-dashed p-4 text-sm text-muted-foreground"
            role="status"
            aria-busy="true"
          >
            正在读取通知配置…
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="button" onClick={submit} disabled={isBusy}>
            {isSaving ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Save className="mr-2 size-4" />
            )}
            保存通知设置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
