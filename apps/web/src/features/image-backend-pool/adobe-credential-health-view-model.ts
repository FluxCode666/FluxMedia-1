/**
 * Adobe 凭据健康视图的纯展示映射。
 *
 * 职责：把健康状态、首要动作和严格诊断字段映射为稳定中文文案与语义样式。
 * 使用方：管理员号池健康组件及 DB-free 单测；不访问数据库、Cookie、Token 或网络。
 */
import type { AdobeCredentialHealthSummary } from "./actions";

export type AdobeHealthStatusView = {
  label: string;
  description: string;
  variant: "secondary" | "outline" | "destructive";
  primaryAction: "none" | "check" | "reauthorize";
};

const STATUS_VIEWS: Record<
  AdobeCredentialHealthSummary["status"],
  AdobeHealthStatusView
> = {
  pending: {
    label: "待首次检查",
    description: "后台健康任务尚未完成第一轮双 Profile 验证。",
    variant: "outline",
    primaryAction: "check",
  },
  healthy: {
    label: "健康",
    description: "最近一轮 Express 与 Firefly 身份验证均通过。",
    variant: "secondary",
    primaryAction: "none",
  },
  degraded: {
    label: "待复检",
    description: "Adobe 凭据出现成员侧失败，系统会按 5/15 分钟窗口复检。",
    variant: "outline",
    primaryAction: "check",
  },
  isolated: {
    label: "已隔离",
    description: "已阻止新租约；已有租约续租不受影响，需同账号重新授权恢复。",
    variant: "destructive",
    primaryAction: "reauthorize",
  },
  overdue: {
    label: "探测失约",
    description: "超过预期检查窗口仍未完成评估，请立即检查并排查调度任务。",
    variant: "destructive",
    primaryAction: "check",
  },
};

/** 返回状态页的固定文案和首要动作。 */
export function getAdobeHealthStatusView(
  status: AdobeCredentialHealthSummary["status"]
): AdobeHealthStatusView {
  return STATUS_VIEWS[status];
}

/** 将健康时间格式化为管理员本地化可读文本。 */
export function formatAdobeHealthTime(
  value: string | null,
  timeZone: string
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** 返回可安全渲染的诊断字段，React 会对值进行纯文本转义。 */
export function getAdobeHealthDiagnosticEntries(
  diagnostic: AdobeCredentialHealthSummary["diagnostic"]
): Array<{ label: string; value: string }> {
  if (!diagnostic) return [];
  return [
    ["HTTP 状态", diagnostic.statusCode?.toString()],
    ["Adobe 错误码", diagnostic.adobeErrorCode],
    ["消息", diagnostic.message],
    ["请求 ID", diagnostic.requestId],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => ({ label, value }));
}
