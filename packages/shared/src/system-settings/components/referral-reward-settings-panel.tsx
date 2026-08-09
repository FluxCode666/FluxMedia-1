"use client";

/**
 * 推广首充奖励专用设置面板。
 *
 * 使用方：管理员设置页的“推广奖励”页签。读取和写入仍复用系统设置的受保护
 * Server Action，但这里只提交推广配置，避免与通用系统设置表单相互覆盖。
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
import { Loader2, Save, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_REFERRAL_REWARD_CONFIG,
  normalizeReferralRewardConfig,
  REFERRAL_REWARD_CONFIG_SETTING_KEY,
  REFERRAL_REWARD_FIXED_MAX,
  REFERRAL_REWARD_PERCENTAGE_MAX,
  type ReferralRewardConfig,
  type ReferralRewardMode,
} from "../../referrals/config";
import {
  getSystemSettingsAction,
  updateSystemSettingsAction,
} from "../actions";

type ReferralRewardDraft = {
  enabled: boolean;
  inviterMode: ReferralRewardMode;
  inviterValue: number;
  inviteeMode: ReferralRewardMode;
  inviteeValue: number;
};

type ReferralSettingMeta = {
  configured: boolean;
  stored: boolean;
  fromEnv: boolean;
  updatedAt: string | null;
};

function toDraft(config: ReferralRewardConfig): ReferralRewardDraft {
  return {
    enabled: config.enabled,
    inviterMode: config.inviter.mode,
    inviterValue: config.inviter.value,
    inviteeMode: config.invitee.mode,
    inviteeValue: config.invitee.value,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** 将输入值限制在配置契约允许的范围，避免表单状态产生不可提交的脏值。 */
function clampReferralValue(
  value: unknown,
  mode: ReferralRewardMode,
  fallback: number
) {
  const numeric = typeof value === "number" ? value : Number(value);
  const max =
    mode === "fixed"
      ? REFERRAL_REWARD_FIXED_MAX
      : REFERRAL_REWARD_PERCENTAGE_MAX;
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(Math.max(fallback, 0), max)
    : 0;
  return Number.isFinite(numeric)
    ? Math.min(Math.max(numeric, 0), max)
    : safeFallback;
}

function serializeDraft(draft: ReferralRewardDraft): ReferralRewardConfig {
  return {
    enabled: draft.enabled,
    inviter: {
      mode: draft.inviterMode,
      value: clampReferralValue(draft.inviterValue, draft.inviterMode, 0),
    },
    invitee: {
      mode: draft.inviteeMode,
      value: clampReferralValue(draft.inviteeValue, draft.inviteeMode, 0),
    },
  };
}

/** 配置一侧奖励的计算模式与数值。 */
function ReferralRewardSideEditor({
  label,
  mode,
  value,
  disabled,
  onModeChange,
  onValueChange,
}: {
  label: string;
  mode: ReferralRewardMode;
  value: number;
  disabled: boolean;
  onModeChange: (mode: ReferralRewardMode) => void;
  onValueChange: (value: number) => void;
}) {
  const max =
    mode === "fixed"
      ? REFERRAL_REWARD_FIXED_MAX
      : REFERRAL_REWARD_PERCENTAGE_MAX;
  return (
    <div className="space-y-3 rounded-md border p-4">
      <Label>{label}</Label>
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(nextMode) =>
          onModeChange(nextMode as ReferralRewardMode)
        }
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="percentage">按首充积分比例</SelectItem>
          <SelectItem value="fixed">固定积分</SelectItem>
        </SelectContent>
      </Select>
      <div className="space-y-1.5">
        <Label className="text-xs">
          {mode === "percentage" ? "比例（%）" : "积分数量"}
        </Label>
        <Input
          type="number"
          min={0}
          max={max}
          step="0.01"
          disabled={disabled}
          value={value}
          onChange={(event) =>
            onValueChange(clampReferralValue(event.target.value, mode, value))
          }
        />
      </div>
    </div>
  );
}

/** 读取当前配置、编辑并幂等提交推广首充奖励设置。 */
export function ReferralRewardSettingsPanel() {
  const [draft, setDraft] = useState<ReferralRewardDraft>(() =>
    toDraft(DEFAULT_REFERRAL_REWARD_CONFIG)
  );
  const [meta, setMeta] = useState<ReferralSettingMeta | null>(null);
  const {
    execute: loadSettings,
    result: settingsResult,
    isPending: isLoading,
  } = useAction(getSystemSettingsAction);
  const { execute: saveSettings, isPending: isSaving } = useAction(
    updateSystemSettingsAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "推广奖励配置保存失败");
      },
    }
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const setting = settingsResult.data?.settings.find(
      (item) => item.key === REFERRAL_REWARD_CONFIG_SETTING_KEY
    );
    if (!setting) return;
    setMeta({
      configured: setting.configured,
      stored: setting.stored,
      fromEnv: setting.fromEnv,
      updatedAt: setting.updatedAt,
    });
    const fallback =
      setting.exampleValue ??
      setting.defaultValue ??
      DEFAULT_REFERRAL_REWARD_CONFIG;
    setDraft(
      toDraft(
        normalizeReferralRewardConfig(parseJson(setting.value) ?? fallback)
      )
    );
  }, [settingsResult.data?.settings]);

  const disabled = isLoading || isSaving;
  const handleSave = () => {
    saveSettings({
      settings: [
        {
          key: REFERRAL_REWARD_CONFIG_SETTING_KEY,
          value: serializeDraft(draft),
        },
      ],
    });
  };
  const handleClear = () => {
    saveSettings({
      settings: [{ key: REFERRAL_REWARD_CONFIG_SETTING_KEY, clear: true }],
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            推广奖励
          </h2>
          <p className="text-sm text-muted-foreground">
            配置新人首次充值后邀请人和新人获得的积分奖励，仅首充发放一次。
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
            disabled={disabled || !meta?.stored}
            title="清空后台配置"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            恢复默认
          </Button>
          <Button type="button" onClick={handleSave} disabled={disabled}>
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存配置
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">首充奖励规则</CardTitle>
              <CardDescription>
                新人通过推广码注册并完成首次成功充值后，双方各获得一次奖励。
              </CardDescription>
            </div>
            {meta?.stored ? (
              <Badge>后台配置</Badge>
            ) : meta?.fromEnv ? (
              <Badge variant="secondary">环境变量</Badge>
            ) : (
              <Badge variant="outline">默认值</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={draft.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))
              }
            />
            启用推广首充双方奖励
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ReferralRewardSideEditor
              label="邀请人奖励"
              mode={draft.inviterMode}
              value={draft.inviterValue}
              disabled={disabled}
              onModeChange={(inviterMode) =>
                setDraft((current) => ({ ...current, inviterMode }))
              }
              onValueChange={(inviterValue) =>
                setDraft((current) => ({ ...current, inviterValue }))
              }
            />
            <ReferralRewardSideEditor
              label="新人奖励"
              mode={draft.inviteeMode}
              value={draft.inviteeValue}
              disabled={disabled}
              onModeChange={(inviteeMode) =>
                setDraft((current) => ({ ...current, inviteeMode }))
              }
              onValueChange={(inviteeValue) =>
                setDraft((current) => ({ ...current, inviteeValue }))
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
