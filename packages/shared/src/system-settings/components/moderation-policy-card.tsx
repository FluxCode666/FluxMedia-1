/**
 * 系统设置页的全站内容审核策略专用卡。
 *
 * 职责：通过 human-only Server Actions 展示和修改全站审核级别，强制填写原因，
 * 并呈现最近全局策略审计；不直接读写 system_setting。
 * 使用方：SystemSettingsPanel 的 moderation 分类。
 * 关键依赖：审核策略专用 actions、Shadcn/UI、展示时区格式化工具。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Label } from "@repo/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import { Separator } from "@repo/ui/components/separator";
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useAction } from "../../platform/use-action";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type {
  ModerationBlockRiskLevel,
  ModerationPolicySource,
  ResolvedModerationPolicyValues,
} from "../../moderation/policy-contract";
import { formatDateInTimeZone } from "../../time-zone";
import {
  getGlobalModerationPolicyAction,
  setGlobalModerationPolicyAction,
} from "../actions";

interface GlobalModerationPolicyAudit {
  id: string;
  adminUserId: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface ActionFeedback {
  kind: "success" | "error";
  message: string;
}

const LEVEL_OPTIONS: ReadonlyArray<{
  value: ModerationBlockRiskLevel;
  label: string;
  description: string;
}> = [
  {
    value: "low",
    label: "Low",
    description: "最严格：阿里云返回 low、medium 或 high 风险时拦截。",
  },
  {
    value: "medium",
    label: "Medium",
    description: "中等：阿里云返回 medium 或 high 风险时拦截。",
  },
  {
    value: "high",
    label: "High",
    description: "最宽松：仅阿里云返回 high 风险时拦截，也是系统回退值。",
  },
];

const SOURCE_LABELS: Record<ModerationPolicySource, string> = {
  user_override: "用户覆盖",
  global: "全站配置",
  fallback_high: "系统 high 回退",
};

/** 从未知审计 metadata 中读取非空字符串，不信任 JSON 字段结构。 */
function getMetadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** 读取审核审计快照中的 level；不把其他 JSON 字段原样输出到页面。 */
function getAuditLevel(snapshot: Record<string, unknown> | null): string {
  const value = snapshot?.level;
  if (value === null || value === undefined) return "未设置";
  return value === "low" || value === "medium" || value === "high"
    ? value
    : "未知";
}

/** 优先显示仍存在的 actor 外键，管理员删除后回退不可变 metadata 快照。 */
function getAuditActor(audit: GlobalModerationPolicyAudit): string {
  return (
    audit.adminUserId ??
    getMetadataString(audit.metadata, "actorUserId") ??
    "未知管理员"
  );
}

/**
 * 渲染全站审核策略专用卡。
 *
 * @param props.timeZone - 当前管理员的有效展示时区。
 * @returns 全宽响应式策略编辑、反馈和最近审计界面。
 * @remarks 保存失败不清空原因；成功后清空原因并重新读取策略与审计。
 */
export function ModerationPolicyCard({ timeZone }: { timeZone: string }) {
  const [policy, setPolicy] =
    useState<ResolvedModerationPolicyValues | null>(null);
  const [audits, setAudits] = useState<GlobalModerationPolicyAudit[]>([]);
  const [level, setLevel] = useState<ModerationBlockRiskLevel>("high");
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const { execute: loadPolicy, isPending: isLoading } = useAction(
    getGlobalModerationPolicyAction,
    {
      onSuccess: ({ data }) => {
        if (!data?.policy) return;
        setPolicy(data.policy);
        setAudits(data.recentAudits ?? []);
        setLevel(data.policy.globalDefault);
      },
      onError: ({ error }) => {
        const message = error.serverError || "全站审核策略加载失败";
        setFeedback({ kind: "error", message });
        toast.error(message);
      },
    }
  );

  const { execute: savePolicy, isPending: isSaving } = useAction(
    setGlobalModerationPolicyAction,
    {
      onSuccess: ({ data }) => {
        const message = data?.message || "全站审核策略已保存";
        setReason("");
        setFeedback({ kind: "success", message });
        toast.success(message);
        loadPolicy();
      },
      onError: ({ error }) => {
        const message = error.serverError || "全站审核策略保存失败";
        // WHY: 管理员已填写的原因是审计上下文，失败时必须保留以便修正后重试。
        setFeedback({ kind: "error", message });
        toast.error(message);
      },
    }
  );

  useEffect(() => {
    loadPolicy();
  }, [loadPolicy]);

  const trimmedReason = reason.trim();
  const reasonInvalid =
    trimmedReason.length === 0 || trimmedReason.length > 300;
  const disabled = isLoading || isSaving;

  /** 校验原因后调用专用策略写 Action，不触达通用设置批量保存。 */
  const handleSave = () => {
    if (reasonInvalid) {
      const message =
        trimmedReason.length === 0
          ? "请填写 1–300 个字符的变更原因"
          : "变更原因最多 300 个字符";
      setFeedback({ kind: "error", message });
      return;
    }
    setFeedback(null);
    savePolicy({ level, reason: trimmedReason });
  };

  return (
    <Card className="w-full rounded-lg border-foreground/15">
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              全站审核拦截级别
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              用户没有管理员覆盖时使用。缺失或非法配置统一回退到最宽松的 high。
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => loadPolicy()}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            刷新
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              全站默认
            </p>
            <p className="mt-1 font-mono text-sm font-medium">
              {policy?.globalDefault ?? "加载中"}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              当前生效
            </p>
            <p className="mt-1 font-mono text-sm font-medium">
              {policy?.effectiveLevel ?? "加载中"}
            </p>
          </div>
          <div className="rounded-md border bg-muted/20 p-3">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
              来源
            </p>
            <div className="mt-1">
              <Badge
                variant={
                  policy?.source === "fallback_high" ? "secondary" : "outline"
                }
              >
                {policy ? SOURCE_LABELS[policy.source] : "加载中"}
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-3">
          {LEVEL_OPTIONS.map((option) => (
            <div key={option.value} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-medium">
                  {option.label}
                </span>
                {level === option.value && <Badge>待保存选择</Badge>}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {option.description}
              </p>
            </div>
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          三档只改变阿里云风险阈值；OpenAI provider 仍按 flagged 结果判断。
        </p>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
          <div className="space-y-2">
            <Label htmlFor="global-moderation-risk-level">审核级别</Label>
            <Select
              value={level}
              disabled={disabled}
              onValueChange={(value) =>
                setLevel(value as ModerationBlockRiskLevel)
              }
            >
              <SelectTrigger id="global-moderation-risk-level">
                <SelectValue placeholder="选择审核级别" />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="global-moderation-change-reason">变更原因</Label>
              <span
                className={`text-xs ${reason.length > 300 ? "text-destructive" : "text-muted-foreground"}`}
              >
                {reason.length}/300
              </span>
            </div>
            <Textarea
              id="global-moderation-change-reason"
              value={reason}
              disabled={disabled}
              rows={3}
              maxLength={300}
              placeholder="必填，说明调整审核级别的业务或安全原因"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div
            role="status"
            className={
              feedback?.kind === "error"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {feedback?.message ?? "保存后下一次生成请求立即读取数据库新值。"}
          </div>
          <Button type="button" disabled={disabled} onClick={handleSave}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存审核策略
          </Button>
        </div>

        <Separator />

        <section className="space-y-3" aria-labelledby="global-policy-audit">
          <div>
            <h4 id="global-policy-audit" className="text-sm font-medium">
              最近全站策略审计
            </h4>
            <p className="text-xs text-muted-foreground">
              仅显示最近 10 次实际变更；无变化的保存不会制造审计记录。
            </p>
          </div>

          {isLoading && audits.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载审计记录
            </div>
          ) : audits.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              暂无全站审核策略变更记录。
            </p>
          ) : (
            <div className="divide-y rounded-md border">
              {audits.map((audit) => {
                const requestId =
                  getMetadataString(audit.metadata, "requestId") ?? "未记录";
                return (
                  <article key={audit.id} className="space-y-2 px-3 py-3">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm font-medium">
                        <span className="font-mono">
                          {getAuditLevel(audit.before)}
                        </span>{" "}
                        →{" "}
                        <span className="font-mono">
                          {getAuditLevel(audit.after)}
                        </span>
                      </p>
                      <time className="text-xs text-muted-foreground">
                        {formatDateInTimeZone(
                          audit.createdAt,
                          "zh",
                          {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                          timeZone
                        )}
                      </time>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {audit.reason || "未记录原因"}
                    </p>
                    <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <span>
                        操作者：
                        <span className="font-mono">
                          {getAuditActor(audit)}
                        </span>
                      </span>
                      <span className="break-all">
                        请求 ID：<span className="font-mono">{requestId}</span>
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
