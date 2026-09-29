/**
 * 用户审核策略管理卡片。
 *
 * 职责：展示全站默认、用户覆盖、生效级别与来源，并允许有权限的管理员
 * 填写原因后设置或清除用户覆盖。使用方为管理员用户详情页；写入统一通过
 * setUserModerationPolicyAction 进入 UOL，组件本身不持有权限或持久化逻辑。
 */

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Textarea } from "@repo/ui/components/textarea";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  type ModerationBlockRiskLevel,
  moderationBlockRiskLevelSchema,
  type ModerationPolicySource,
  type ResolvedModerationPolicyValues,
} from "../../../moderation/policy-contract";
import { setUserModerationPolicyAction } from "../../actions/admin-users";

const INHERIT_GLOBAL_VALUE = "inherit_global" as const;
type ModerationPolicySelection =
  | typeof INHERIT_GLOBAL_VALUE
  | ModerationBlockRiskLevel;

interface ModerationPolicyControlProps {
  userId: string;
  policy: ResolvedModerationPolicyValues;
  canManage: boolean;
  readOnlyReason: string;
  onUpdated: () => Promise<void> | void;
}

const LEVEL_OPTIONS: ReadonlyArray<{
  value: ModerationBlockRiskLevel;
  label: string;
}> = [
  { value: "low", label: "low（严格）" },
  { value: "medium", label: "medium（均衡）" },
  { value: "high", label: "high（宽松）" },
];

/**
 * 把审核级别转换为管理员易于判断严格程度的标签。
 *
 * @param level - 已由服务端归一的审核级别。
 * @returns 带严格程度说明的显示文本；无副作用且不会失败。
 */
function getLevelLabel(level: ModerationBlockRiskLevel): string {
  return LEVEL_OPTIONS.find((option) => option.value === level)?.label ?? level;
}

/**
 * 把生效来源转换为中文标签。
 *
 * @param source - 服务端返回的策略来源。
 * @returns 对应的来源说明；无副作用且不会失败。
 */
function getSourceLabel(source: ModerationPolicySource): string {
  switch (source) {
    case "user_override":
      return "管理员用户覆盖";
    case "global":
      return "全站默认";
    case "fallback_high":
      return "安全回退到 high";
  }
}

/**
 * 收窄 Select 返回的字符串，拒绝组件选项之外的值。
 *
 * @param value - Select 的未收窄字符串值。
 * @returns 值是否为受支持的审核级别；无副作用。
 */
function isModerationLevel(value: string): value is ModerationBlockRiskLevel {
  return moderationBlockRiskLevelSchema.safeParse(value).success;
}

/**
 * 展示和编辑单个用户的审核策略。
 *
 * @param props - 用户 ID、可信策略视图、权限状态与刷新回调。
 * @returns 响应式策略卡片。提交会调用 Server Action、显示 toast，并在成功后
 * 刷新父级详情；失败时保留管理员填写的原因以便重试。
 */
export function ModerationPolicyControl({
  userId,
  policy,
  canManage,
  readOnlyReason,
  onUpdated,
}: ModerationPolicyControlProps) {
  const [selectedLevel, setSelectedLevel] = useState<ModerationPolicySelection>(
    policy.userOverride ?? INHERIT_GLOBAL_VALUE
  );
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

  useEffect(() => {
    setSelectedLevel(policy.userOverride ?? INHERIT_GLOBAL_VALUE);
  }, [policy.userOverride]);

  const currentSelection = policy.userOverride ?? INHERIT_GLOBAL_VALUE;
  const hasChanged = selectedLevel !== currentSelection;

  /**
   * 校验原因并提交审核策略变更。
   *
   * 成功后清空原因并刷新详情；Action 错误或网络异常会保留原因并显示反馈。
   */
  const handleSubmit = async () => {
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) {
      const message = "请填写审核策略变更原因";
      setResultMessage(message);
      toast.error(message);
      return;
    }
    if (normalizedReason.length > 300) {
      const message = "变更原因最多 300 个字符";
      setResultMessage(message);
      toast.error(message);
      return;
    }
    if (!hasChanged) {
      setResultMessage("请选择不同的用户审核策略");
      return;
    }

    setIsSubmitting(true);
    setResultMessage(null);
    try {
      const result = await setUserModerationPolicyAction({
        userId,
        level: selectedLevel === INHERIT_GLOBAL_VALUE ? null : selectedLevel,
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
        const message = "审核策略输入校验失败，请检查后重试";
        setResultMessage(message);
        toast.error(message);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "审核策略更新失败";
      setResultMessage(message);
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">内容审核策略</CardTitle>
        <CardDescription>
          用户不能自行选择审核级别；实际生成始终使用此处解析后的策略。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PolicyValue
            label="全站默认"
            value={getLevelLabel(policy.globalDefault)}
          />
          <PolicyValue
            label="用户覆盖"
            value={
              policy.userOverride === null
                ? "继承全站"
                : getLevelLabel(policy.userOverride)
            }
          />
          <PolicyValue
            label="实际生效"
            value={getLevelLabel(policy.effectiveLevel)}
          />
          <div className="min-w-0 rounded-md border bg-muted/20 p-3">
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              来源
            </div>
            <Badge
              variant="secondary"
              className="mt-2 max-w-full whitespace-normal"
            >
              {getSourceLabel(policy.source)}
            </Badge>
          </div>
        </div>

        {canManage ? (
          <div className="grid gap-4 rounded-lg border bg-muted/10 p-4 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
            <div className="space-y-2">
              <Label htmlFor={`moderation-level-${userId}`}>用户审核级别</Label>
              <Select
                value={selectedLevel}
                disabled={isSubmitting}
                onValueChange={(value) => {
                  setSelectedLevel(
                    isModerationLevel(value) ? value : INHERIT_GLOBAL_VALUE
                  );
                  setResultMessage(null);
                }}
              >
                <SelectTrigger id={`moderation-level-${userId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT_GLOBAL_VALUE}>继承全站</SelectItem>
                  {LEVEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor={`moderation-reason-${userId}`}>变更原因</Label>
              <Textarea
                id={`moderation-reason-${userId}`}
                value={reason}
                disabled={isSubmitting}
                maxLength={300}
                placeholder="必填，例如：风险复核、误拦截处理或客户合规要求"
                onChange={(event) => {
                  setReason(event.target.value);
                  setResultMessage(null);
                }}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs text-muted-foreground">
                  {reason.length}/300，去除首尾空格后至少 1 个字符
                </span>
                <Button
                  type="button"
                  disabled={isSubmitting || !hasChanged}
                  onClick={() => void handleSubmit()}
                >
                  {isSubmitting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  保存审核策略
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

/**
 * 渲染单个审核策略只读值。
 *
 * @param props - 字段标签与已格式化值。
 * @returns 可换行的策略值块；无副作用。
 */
function PolicyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 p-3">
      <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 break-words text-sm font-medium">{value}</div>
    </div>
  );
}
