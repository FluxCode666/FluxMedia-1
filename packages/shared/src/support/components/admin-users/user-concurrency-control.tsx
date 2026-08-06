/**
 * 用户生图并发管理卡片。
 *
 * 职责：展示系统默认、用户覆盖、生效并发及全局媒体参数，并允许有权限的管理员
 * 填写原因后设置或清空用户覆盖。写入统一通过 UOL，不在组件中直接访问数据库。
 */
"use client";

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
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { MediaLimitsForUser } from "../../../image-generation/media-limit-service";
import { setUserImageGenerationConcurrencyAction } from "../../actions/admin-users";

interface UserConcurrencyControlProps {
  userId: string;
  limits: MediaLimitsForUser;
  canManage: boolean;
  readOnlyReason: string;
  onUpdated: () => Promise<void> | void;
}

/** 展示和编辑单个用户的生图并发覆盖。 */
export function UserConcurrencyControl({
  userId,
  limits,
  canManage,
  readOnlyReason,
  onUpdated,
}: UserConcurrencyControlProps) {
  const [overrideText, setOverrideText] = useState(
    limits.override === null ? "" : String(limits.override)
  );
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    setOverrideText(limits.override === null ? "" : String(limits.override));
  }, [limits.override]);

  const normalizedCurrent =
    limits.override === null ? "" : String(limits.override);
  const hasChanged = overrideText.trim() !== normalizedCurrent;

  /** 校验管理员输入并提交用户并发覆盖；空输入明确表示恢复继承系统默认。 */
  const handleSubmit = async () => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      toast.error("请填写并发限制变更原因");
      return;
    }
    const normalizedOverride = overrideText.trim();
    const override =
      normalizedOverride === "" ? null : Number(normalizedOverride);
    if (
      override !== null &&
      (!Number.isSafeInteger(override) || override < 1 || override > 10_000)
    ) {
      toast.error("用户生图并发必须是 1 至 10000 的整数，留空表示继承系统默认");
      return;
    }
    if (!hasChanged) {
      setResultMessage("请设置不同的用户并发覆盖");
      return;
    }

    setIsSubmitting(true);
    setResultMessage(null);
    try {
      const result = await setUserImageGenerationConcurrencyAction({
        userId,
        override,
        reason: normalizedReason,
      });
      if (result?.data) {
        setReason("");
        setResultMessage(result.data.message);
        toast.success(result.data.message);
        await onUpdated();
      } else if (result?.serverError) {
        setResultMessage(result.serverError);
        toast.error(result.serverError);
      } else {
        setResultMessage("并发限制输入校验失败，请检查后重试");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "并发限制更新失败";
      setResultMessage(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">媒体资源限制</CardTitle>
        <CardDescription>
          用户并发可单独覆盖；文件、上传总量和编辑参考图由系统设置统一控制。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <LimitValue
            label="系统默认并发"
            value={limits.defaultUserConcurrency}
          />
          <LimitValue
            label="用户覆盖"
            value={limits.override === null ? "继承系统" : limits.override}
          />
          <LimitValue label="实际生效并发" value={limits.limit} />
          <div className="rounded-md border bg-muted/20 p-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              来源
            </div>
            <Badge variant="secondary" className="mt-2">
              {limits.effectiveSource === "user_override"
                ? "管理员用户覆盖"
                : "系统默认"}
            </Badge>
          </div>
          <LimitValue label="单文件" value={`${limits.maxFileSizeMb} MB`} />
          <LimitValue label="单次上传" value={`${limits.maxUploadSizeMb} MB`} />
          <LimitValue
            label="编辑参考图"
            value={`${limits.maxEditReferenceImages} 张`}
          />
        </div>

        {canManage ? (
          <div className="grid gap-4 rounded-lg border bg-muted/10 p-4 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor={`user-concurrency-${userId}`}>
                用户生图并发覆盖
              </Label>
              <Input
                id={`user-concurrency-${userId}`}
                type="number"
                min={1}
                max={10_000}
                step={1}
                value={overrideText}
                disabled={isSubmitting}
                placeholder={`留空继承 ${limits.defaultUserConcurrency}`}
                onChange={(event) => {
                  setOverrideText(event.target.value);
                  setResultMessage(null);
                }}
              />
              <p className="text-xs text-muted-foreground">
                允许 1 至 10000；清空输入后保存即可恢复系统默认。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`user-concurrency-reason-${userId}`}>
                变更原因
              </Label>
              <Textarea
                id={`user-concurrency-reason-${userId}`}
                value={reason}
                disabled={isSubmitting}
                maxLength={300}
                placeholder="必填，例如：客户容量调整或异常任务治理"
                onChange={(event) => {
                  setReason(event.target.value);
                  setResultMessage(null);
                }}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  disabled={isSubmitting || !hasChanged}
                  onClick={() => void handleSubmit()}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  保存并发限制
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
            只读：{readOnlyReason}
          </div>
        )}

        <p
          role="status"
          aria-live="polite"
          className="min-h-5 text-sm text-muted-foreground"
        >
          {resultMessage ?? ""}
        </p>
      </CardContent>
    </Card>
  );
}

/** 渲染单个媒体限制只读值。 */
function LimitValue({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-medium">{value}</div>
    </div>
  );
}
