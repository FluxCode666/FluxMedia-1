"use client";

import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Textarea } from "@repo/ui/components/textarea";
import { Database, Download, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  REFERRAL_REWARD_CONFIG_SETTING_KEY,
  REFERRAL_REWARD_FIXED_MAX,
  REFERRAL_REWARD_PERCENTAGE_MAX,
  type ReferralRewardMode,
} from "../../referrals/config";
import { formatDateInTimeZone } from "../../time-zone";

import {
  getSystemSettingsAction,
  importSystemSettingsFromEnvAction,
  initializeSystemSettingsDefaultsAction,
  updateSystemSettingsAction,
} from "../actions";
import type {
  SettingCategory,
  SettingDefinition,
  SettingKey,
} from "../definitions";
import { SETTING_CATEGORIES } from "../definitions";
import { DashboardSupportConfigInput } from "./dashboard-support-config-input";
import { ModerationPolicyCard } from "./moderation-policy-card";
import { PaginationPageSizeOptionsInput } from "./pagination-page-size-options-input";
import { SiteLogoSettingsCard } from "./site-logo-settings-card";

type SettingSnapshotItem = SettingDefinition & {
  value: string;
  configured: boolean;
  stored: boolean;
  fromEnv: boolean;
  updatedAt: string | null;
};

type DraftValue = string | number | boolean | unknown;
type SettingUpdate = {
  key: string;
  value?: DraftValue;
  clear?: boolean;
};

type CreditPackageDraft = {
  id: string;
  name: string;
  description: string;
  credits: number;
  price: number;
  currency: string;
  popular: boolean;
  visible: boolean;
  allowQuantity: boolean;
  maxQuantity: number;
  creemProductId: string;
};

type CreditPackageMatrixDraft = {
  packages: CreditPackageDraft[];
};

type CreditTopUpConfigDraft = {
  enabled: boolean;
  creditsPerYuan: number;
  minAmountYuan: number;
  maxAmountYuan: number;
  extraCurrencies: unknown[];
};

type ReferralRewardDraft = {
  enabled: boolean;
  inviterMode: ReferralRewardMode;
  inviterValue: number;
  inviteeMode: ReferralRewardMode;
  inviteeValue: number;
};

function formatJsonExample(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonDraft(value: DraftValue) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/** 规范化奖励表单数值，允许 0 并按当前模式截断到配置层相同上限。 */
function referralRewardValue(
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

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 找到配置中的指定币种项，并忽略格式不正确的历史配置。
 *
 * 支付配置由管理员手填或环境变量导入，不能假定 currencies 中每项都是对象；
 * 在表单渲染阶段先收窄，避免一条坏配置让整个系统设置页面无法打开。
 */
function findTopUpCurrencyConfig(value: unknown, currency: string) {
  if (!isRecord(value) || !Array.isArray(value.currencies)) return undefined;
  return value.currencies.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) &&
      stringValue(item.currency).trim().toUpperCase() === currency
  );
}

/**
 * 将当前保存值或示例值转换为后台的 CNY 充值表单草稿。
 *
 * 支付宝当面付只能收人民币，故把最常用且实际可用的 CNY 比例单独暴露为表单。
 * 其他币种原样保留，避免未来新增支付渠道后因编辑 CNY 比例而丢失已有配置。
 */
function normalizeCreditTopUpConfigDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): CreditTopUpConfigDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const raw = isRecord(parsedRaw) ? parsedRaw : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};
  const rawCny = findTopUpCurrencyConfig(raw, "CNY");
  const fallbackCny = findTopUpCurrencyConfig(fallback, "CNY");
  const cny = rawCny ?? fallbackCny ?? {};
  const currencies = Array.isArray(raw.currencies)
    ? raw.currencies
    : Array.isArray(fallback.currencies)
      ? fallback.currencies
      : [];

  return {
    enabled: booleanValue(raw.enabled, booleanValue(fallback.enabled, true)),
    creditsPerYuan: numberValue(
      cny.creditsPerMajorUnit,
      numberValue(fallbackCny?.creditsPerMajorUnit, 10)
    ),
    minAmountYuan:
      numberValue(
        cny.minAmountMinor,
        numberValue(fallbackCny?.minAmountMinor, 100)
      ) / 100,
    maxAmountYuan:
      numberValue(
        cny.maxAmountMinor,
        numberValue(fallbackCny?.maxAmountMinor, 1_000_000)
      ) / 100,
    extraCurrencies: currencies.filter(
      (item) =>
        !isRecord(item) ||
        stringValue(item.currency).trim().toUpperCase() !== "CNY"
    ),
  };
}

/**
 * 将可见表单字段写回充值配置 JSON。
 *
 * 金额在运行时使用分，表单用元避免管理员把 ¥1 误填为 100；保存时再精确转换回
 * 最小货币单位，并仅保留两位小数，匹配支付宝 CNY 的金额语义。
 */
function compactCreditTopUpConfigDraft(draft: CreditTopUpConfigDraft) {
  const minAmountMinor = Math.max(1, Math.round(draft.minAmountYuan * 100));
  const maxAmountMinor = Math.max(
    minAmountMinor,
    Math.round(draft.maxAmountYuan * 100)
  );

  return {
    enabled: draft.enabled,
    defaultCurrency: "CNY",
    currencies: [
      {
        currency: "CNY",
        creditsPerMajorUnit: Math.max(0.01, draft.creditsPerYuan),
        minAmountMinor,
        maxAmountMinor,
        enabled: true,
        providers: ["alipay_f2f"],
      },
      ...draft.extraCurrencies,
    ],
  };
}

/** 将推广 JSON 规范为管理员可编辑表单，坏值回退示例而不让整页崩溃。 */
function normalizeReferralRewardDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): ReferralRewardDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const raw = isRecord(parsedRaw) ? parsedRaw : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};
  const rawInviter = isRecord(raw.inviter) ? raw.inviter : {};
  const rawInvitee = isRecord(raw.invitee) ? raw.invitee : {};
  const fallbackInviter = isRecord(fallback.inviter) ? fallback.inviter : {};
  const fallbackInvitee = isRecord(fallback.invitee) ? fallback.invitee : {};
  const inviterMode: ReferralRewardMode =
    rawInviter.mode === "fixed" || rawInviter.mode === "percentage"
      ? rawInviter.mode
      : fallbackInviter.mode === "fixed"
        ? "fixed"
        : "percentage";
  const inviteeMode: ReferralRewardMode =
    rawInvitee.mode === "fixed" || rawInvitee.mode === "percentage"
      ? rawInvitee.mode
      : fallbackInvitee.mode === "fixed"
        ? "fixed"
        : "percentage";
  return {
    enabled: booleanValue(raw.enabled, booleanValue(fallback.enabled, false)),
    inviterMode,
    inviterValue: referralRewardValue(
      rawInviter.value,
      inviterMode,
      referralRewardValue(
        fallbackInviter.value,
        inviterMode,
        inviterMode === "fixed" ? 0 : 10
      )
    ),
    inviteeMode,
    inviteeValue: referralRewardValue(
      rawInvitee.value,
      inviteeMode,
      referralRewardValue(
        fallbackInvitee.value,
        inviteeMode,
        inviteeMode === "fixed" ? 0 : 10
      )
    ),
  };
}

function ReferralRewardConfigInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: {
  value: DraftValue;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const draft = normalizeReferralRewardDraft(value, fallbackValue);
  const update = (next: Partial<ReferralRewardDraft>) => {
    const merged = { ...draft, ...next };
    onChange(
      JSON.stringify(
        {
          enabled: merged.enabled,
          inviter: { mode: merged.inviterMode, value: merged.inviterValue },
          invitee: { mode: merged.inviteeMode, value: merged.inviteeValue },
        },
        null,
        2
      )
    );
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => update({ enabled })}
        />
        启用推广首充双方奖励
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {(
          [
            ["邀请人奖励", "inviterMode", "inviterValue"],
            ["新人奖励", "inviteeMode", "inviteeValue"],
          ] as const
        ).map(([label, modeKey, valueKey]) => (
          <div key={label} className="space-y-3 rounded-md border p-4">
            <Label>{label}</Label>
            <Select
              value={draft[modeKey]}
              disabled={disabled}
              onValueChange={(mode: ReferralRewardMode) =>
                update({ [modeKey]: mode })
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
                {draft[modeKey] === "percentage" ? "比例（%）" : "积分数量"}
              </Label>
              <Input
                type="number"
                min={0}
                max={
                  draft[modeKey] === "percentage"
                    ? REFERRAL_REWARD_PERCENTAGE_MAX
                    : REFERRAL_REWARD_FIXED_MAX
                }
                step="0.01"
                disabled={disabled}
                value={draft[valueKey]}
                onChange={(event) =>
                  update({
                    [valueKey]: referralRewardValue(
                      event.target.value,
                      draft[modeKey],
                      draft[valueKey]
                    ),
                  })
                }
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function getRawCreditPackages(value: unknown) {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.packages)) return value.packages;
  return [];
}

function normalizeCreditPackageMatrixDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): CreditPackageMatrixDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const rawPackages = getRawCreditPackages(parsedRaw);
  const fallbackPackages = getRawCreditPackages(fallbackValue);
  const hasRawPackages =
    Array.isArray(parsedRaw) ||
    (isRecord(parsedRaw) && Array.isArray(parsedRaw.packages));
  const fallbackById = new Map(
    fallbackPackages
      .filter(isRecord)
      .map((pkg) => [stringValue(pkg.id), pkg] as const)
      .filter(([id]) => Boolean(id))
  );
  const sourcePackages = hasRawPackages ? rawPackages : fallbackPackages;

  return {
    packages: sourcePackages
      .map((rawPackage, index) => {
        if (!isRecord(rawPackage)) return null;
        const fallback = fallbackById.get(stringValue(rawPackage.id)) ?? {};
        const id = stringValue(rawPackage.id, stringValue(fallback.id)).trim();
        if (!id) return null;
        const price = numberValue(
          rawPackage.price,
          numberValue(fallback.price, 1)
        );
        return {
          id,
          name: stringValue(rawPackage.name, stringValue(fallback.name, id)),
          description: stringValue(
            rawPackage.description,
            stringValue(fallback.description)
          ),
          credits: numberValue(
            rawPackage.credits,
            numberValue(fallback.credits, 1)
          ),
          price,
          currency: stringValue(
            rawPackage.currency,
            stringValue(fallback.currency, "CNY")
          )
            .trim()
            .toUpperCase(),
          popular: booleanValue(rawPackage.popular, Boolean(fallback.popular)),
          visible: booleanValue(
            rawPackage.visible,
            fallback.visible === undefined ? true : Boolean(fallback.visible)
          ),
          allowQuantity: booleanValue(
            rawPackage.allowQuantity,
            Boolean(fallback.allowQuantity)
          ),
          maxQuantity: numberValue(
            rawPackage.maxQuantity,
            numberValue(fallback.maxQuantity, 1)
          ),
          creemProductId: stringValue(
            rawPackage.creemProductId,
            stringValue(fallback.creemProductId)
          ),
          sortIndex: index,
        };
      })
      .filter((pkg): pkg is CreditPackageDraft & { sortIndex: number } =>
        Boolean(pkg)
      )
      .sort((a, b) => a.sortIndex - b.sortIndex)
      .map(({ sortIndex: _sortIndex, ...pkg }) => pkg),
  };
}

function compactCreditPackageMatrixDraft(matrix: CreditPackageMatrixDraft) {
  return {
    packages: matrix.packages.map((pkg) => ({
      id: pkg.id.trim(),
      name: pkg.name.trim() || pkg.id.trim(),
      description: pkg.description,
      credits: Number(pkg.credits) || 1,
      price: Number(pkg.price) || 1,
      currency: pkg.currency.trim().toUpperCase() || "CNY",
      popular: pkg.popular,
      visible: pkg.visible,
      allowQuantity: pkg.allowQuantity,
      maxQuantity: Number(pkg.maxQuantity) || 1,
      ...(pkg.creemProductId.trim()
        ? { creemProductId: pkg.creemProductId.trim() }
        : {}),
    })),
  };
}

function getJsonSettingHint(key: string) {
  if (key === "PAGINATION_PAGE_SIZE_OPTIONS") {
    return "默认允许每页 10、20、50 条；固定默认值 20 必须保留。保存后所有列表的新请求动态生效。";
  }
  if (key === "CREDIT_PACKAGE_MATRIX") {
    return "留空表示使用代码默认一次性充值包。填写 JSON 后保存才会启用自定义充值选项；每个充值包只配置统一的积分数和价格。";
  }
  if (key === "CREDIT_TOP_UP_CONFIG") {
    return "金额以最小货币单位填写：CNY 的 100 表示 ¥1。creditsPerMajorUnit 是每 1 主货币单位兑换的积分数，例如 CNY=10 即 ¥1=10 积分。支付宝当面付仅允许 CNY。";
  }
  return "留空表示使用代码默认值。占位内容只是示例，填写 JSON 后保存才会启用自定义配置。";
}

function normalizeDraftValue(setting: SettingSnapshotItem): DraftValue {
  if (setting.valueType === "boolean") {
    if (setting.stored) return setting.value === "true";
    return Boolean(setting.defaultValue);
  }
  if (setting.valueType === "number") {
    if (setting.stored && setting.value !== "") return Number(setting.value);
    return typeof setting.defaultValue === "number" ? setting.defaultValue : "";
  }
  if (setting.valueType === "json") {
    if (setting.value) return setting.value;
    if (typeof setting.defaultValue === "string") return setting.defaultValue;
    if (setting.defaultValue !== undefined) {
      return formatJsonExample(setting.defaultValue);
    }
    return "";
  }
  return setting.value || "";
}

function toSubmitValue(setting: SettingSnapshotItem, value: DraftValue) {
  if (setting.valueType === "boolean") return Boolean(value);
  if (setting.valueType === "number") return Number(value);
  if (setting.valueType === "json") {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed ? JSON.parse(trimmed) : "";
  }
  return String(value ?? "");
}

function SettingInput({
  setting,
  value,
  disabled,
  onChange,
}: {
  setting: SettingSnapshotItem;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  if (setting.key === "PAGINATION_PAGE_SIZE_OPTIONS") {
    return (
      <PaginationPageSizeOptionsInput
        disabled={disabled}
        onChange={onChange}
        value={value}
      />
    );
  }

  if (setting.key === "DASHBOARD_SUPPORT_CONFIG") {
    return (
      <DashboardSupportConfigInput
        disabled={disabled}
        fallbackValue={setting.exampleValue ?? setting.defaultValue}
        onChange={(nextValue) => onChange(nextValue)}
        value={value}
      />
    );
  }

  if (setting.key === "CREDIT_PACKAGE_MATRIX") {
    return (
      <CreditPackageMatrixInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (setting.key === "CREDIT_TOP_UP_CONFIG") {
    return (
      <CreditTopUpConfigInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (setting.key === REFERRAL_REWARD_CONFIG_SETTING_KEY) {
    return (
      <ReferralRewardConfigInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (setting.valueType === "boolean") {
    return (
      <Switch
        checked={Boolean(value)}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    );
  }

  if (setting.valueType === "select") {
    return (
      <Select
        value={String(value || "")}
        disabled={disabled}
        onValueChange={onChange}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {(setting.options ?? []).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (setting.valueType === "json") {
    const placeholder =
      setting.exampleValue !== undefined
        ? formatJsonExample(setting.exampleValue)
        : "{}";
    return (
      <Textarea
        value={String(value ?? "")}
        rows={18}
        className="min-h-72 resize-y font-mono text-xs"
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <Input
      type={setting.valueType === "number" ? "number" : "text"}
      min={setting.valueType === "number" ? setting.min : undefined}
      max={setting.valueType === "number" ? setting.max : undefined}
      step={setting.valueType === "number" && setting.integer ? 1 : undefined}
      value={String(value)}
      placeholder={
        setting.secret && setting.configured ? "已配置，留空不修改" : ""
      }
      disabled={disabled}
      onChange={(event) =>
        onChange(
          setting.valueType === "number"
            ? event.target.value
            : event.target.value
        )
      }
    />
  );
}

/**
 * 按金额充值的可视化后台表单。
 *
 * 使用方：系统设置“积分”标签页。所有修改仍序列化到既有 CREDIT_TOP_UP_CONFIG，
 * 因此不改变订单快照、报价和支付宝履约的服务端契约。
 */
function CreditTopUpConfigInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: {
  value: DraftValue;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const config = useMemo(
    () => normalizeCreditTopUpConfigDraft(value, fallbackValue),
    [value, fallbackValue]
  );
  const preview = useMemo(
    () => JSON.stringify(compactCreditTopUpConfigDraft(config), null, 2),
    [config]
  );

  const updateConfig = (patch: Partial<CreditTopUpConfigDraft>) => {
    onChange(
      JSON.stringify(
        compactCreditTopUpConfigDraft({ ...config, ...patch }),
        null,
        2
      )
    );
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        支付宝当面付仅支持人民币。订单创建时会冻结充值比例和金额，之后修改比例不会影响已创建订单。
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2 rounded-md border px-3 py-2">
          <Label
            htmlFor="credit-top-up-enabled"
            className="text-[11px] uppercase tracking-widest text-muted-foreground"
          >
            开启按金额充值
          </Label>
          <div className="flex h-10 items-center">
            <Switch
              id="credit-top-up-enabled"
              checked={config.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => updateConfig({ enabled })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
            充值比例（每 ¥1 积分）
          </Label>
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={String(config.creditsPerYuan)}
            disabled={disabled}
            onChange={(event) =>
              updateConfig({ creditsPerYuan: Number(event.target.value) })
            }
          />
          <p className="text-xs text-muted-foreground">
            当前：¥1 = {config.creditsPerYuan} Credits
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
            最低充值金额（¥）
          </Label>
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={String(config.minAmountYuan)}
            disabled={disabled}
            onChange={(event) =>
              updateConfig({ minAmountYuan: Number(event.target.value) })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
            最高充值金额（¥）
          </Label>
          <Input
            type="number"
            min={String(config.minAmountYuan)}
            step="0.01"
            value={String(config.maxAmountYuan)}
            disabled={disabled}
            onChange={(event) =>
              updateConfig({ maxAmountYuan: Number(event.target.value) })
            }
          />
        </div>
      </div>

      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          查看保存的 JSON
        </summary>
        <Textarea
          value={preview}
          rows={12}
          readOnly
          className="mt-3 resize-y font-mono text-xs"
        />
      </details>
    </div>
  );
}

function CreditPackageMatrixInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: {
  value: DraftValue;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const matrix = useMemo(
    () => normalizeCreditPackageMatrixDraft(value, fallbackValue),
    [value, fallbackValue]
  );
  const compactMatrix = useMemo(
    () => compactCreditPackageMatrixDraft(matrix),
    [matrix]
  );
  const preview = useMemo(
    () => JSON.stringify(compactMatrix, null, 2),
    [compactMatrix]
  );

  const updateMatrix = (next: CreditPackageMatrixDraft) => {
    onChange(JSON.stringify(compactCreditPackageMatrixDraft(next), null, 2));
  };

  const updatePackage = (index: number, patch: Partial<CreditPackageDraft>) => {
    updateMatrix({
      packages: matrix.packages.map((pkg, currentIndex) =>
        currentIndex === index ? { ...pkg, ...patch } : pkg
      ),
    });
  };

  const addPackage = () => {
    const nextIndex = matrix.packages.length + 1;
    const id = `custom_${nextIndex}`;
    updateMatrix({
      packages: [
        ...matrix.packages,
        {
          id,
          name: `Custom ${nextIndex}`,
          description: "",
          credits: 1000,
          price: 10,
          currency: "CNY",
          popular: false,
          visible: true,
          allowQuantity: false,
          maxQuantity: 1,
          creemProductId: "",
        },
      ],
    });
  };

  const removePackage = (index: number) => {
    updateMatrix({
      packages: matrix.packages.filter(
        (_, currentIndex) => currentIndex !== index
      ),
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        管理一次性购买积分包。Epay 仅支持 CNY；Creem
        可使用各币种对应的预建产品，每个积分包只有一套统一价格。
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={addPackage}
        >
          <Plus className="mr-2 h-4 w-4" />
          新增积分包
        </Button>
      </div>

      {matrix.packages.map((pkg, index) => (
        <section
          // 积分包 ID 是结账与履约使用的业务主键；规范化阶段已按 ID 合并，故用它
          // 作为稳定 React key，避免排序或删除后把相邻表单状态复用到错误积分包。
          key={pkg.id}
          className="space-y-3 rounded-md border p-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium">{pkg.name || pkg.id}</h4>
              <p className="text-xs text-muted-foreground">
                ID: {pkg.id || "未填写"}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={disabled}
              title="删除积分包"
              onClick={() => removePackage(index)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                包 ID
              </Label>
              <Input
                value={pkg.id}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { id: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                显示名称
              </Label>
              <Input
                value={pkg.name}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { name: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                积分数
              </Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={String(pkg.credits)}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { credits: Number(event.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                统一价格
              </Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={String(pkg.price)}
                disabled={disabled}
                onChange={(event) =>
                  updatePackage(index, { price: Number(event.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                结账币种
              </Label>
              <Input
                value={pkg.currency}
                maxLength={3}
                disabled={disabled}
                placeholder="CNY"
                onChange={(event) =>
                  updatePackage(index, {
                    currency: event.target.value.toUpperCase(),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                最大购买数量
              </Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={String(pkg.maxQuantity)}
                disabled={disabled || !pkg.allowQuantity}
                onChange={(event) =>
                  updatePackage(index, {
                    maxQuantity: Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                Creem 产品 ID
              </Label>
              <Input
                value={pkg.creemProductId}
                disabled={disabled}
                placeholder={`credits_${pkg.id || "package"}`}
                onChange={(event) =>
                  updatePackage(index, { creemProductId: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
                开关
              </Label>
              {/* Radix Switch 渲染为 button,biome 不识别包裹式 label,
                  用 htmlFor/id 显式关联(按 index 唯一化) */}
              <div className="flex flex-wrap gap-4 rounded-md border px-3 py-2">
                <label
                  htmlFor={`pkg-${index}-visible`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-visible`}
                    checked={pkg.visible}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, { visible: checked })
                    }
                  />
                  显示
                </label>
                <label
                  htmlFor={`pkg-${index}-popular`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-popular`}
                    checked={pkg.popular}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, { popular: checked })
                    }
                  />
                  推荐
                </label>
                <label
                  htmlFor={`pkg-${index}-allow-quantity`}
                  className="flex items-center gap-2 text-sm"
                >
                  <Switch
                    id={`pkg-${index}-allow-quantity`}
                    checked={pkg.allowQuantity}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      updatePackage(index, {
                        allowQuantity: checked,
                        maxQuantity: checked ? pkg.maxQuantity : 1,
                      })
                    }
                  />
                  允许数量购买
                </label>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-widest text-muted-foreground">
              说明
            </Label>
            <Textarea
              value={pkg.description}
              rows={2}
              disabled={disabled}
              className="resize-y"
              onChange={(event) =>
                updatePackage(index, { description: event.target.value })
              }
            />
          </div>
        </section>
      ))}

      <details className="rounded-md border bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          查看当前 JSON 预览
        </summary>
        <Textarea
          value={preview}
          rows={12}
          readOnly
          className="mt-3 resize-y font-mono text-xs"
        />
      </details>
    </div>
  );
}

export function SystemSettingsPanel({
  timeZone,
  notificationModule,
}: {
  timeZone: string;
  notificationModule?: ReactNode;
}) {
  const [settings, setSettings] = useState<SettingSnapshotItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftValue>>({});
  const [clearKeys, setClearKeys] = useState<Record<string, boolean>>({});

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
        toast.error(error.serverError || "系统设置保存失败");
      },
    }
  );
  const { execute: importEnvSettings, isPending: isImporting } = useAction(
    importSystemSettingsFromEnvAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "导入环境变量失败");
      },
    }
  );
  const { execute: initializeDefaults, isPending: isInitializing } = useAction(
    initializeSystemSettingsDefaultsAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) toast.success(data.message);
        loadSettings();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || "初始化默认配置失败");
      },
    }
  );

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const loaded = (settingsResult.data?.settings ??
      []) as SettingSnapshotItem[];
    if (!loaded.length) return;
    setSettings(loaded);
    setDrafts(
      Object.fromEntries(
        loaded.map((setting) => [setting.key, normalizeDraftValue(setting)])
      )
    );
    setClearKeys({});
  }, [settingsResult.data?.settings]);

  const settingsByCategory = useMemo(() => {
    const map = new Map<SettingCategory, SettingSnapshotItem[]>();
    for (const category of SETTING_CATEGORIES) {
      map.set(category.id, []);
    }
    for (const setting of settings) {
      // 专用 operation 管理的配置由独立卡片负责，不能进入通用 grid 或批量保存。
      if (
        setting.managedByDedicatedOperation ||
        setting.key === "CONTENT_MODERATION_BLOCK_RISK_LEVEL"
      ) {
        continue;
      }
      map.get(setting.category)?.push(setting);
    }
    return map;
  }, [settings]);
  const siteLogoSetting = useMemo(
    () => settings.find((setting) => setting.key === "SITE_LOGO_URL"),
    [settings]
  );
  const handleSave = () => {
    const payload: SettingUpdate[] = [];
    try {
      for (const setting of settings) {
        // 双重排除专用治理键：即使服务端快照标记缺失，也不能从批量入口提交。
        if (
          setting.managedByDedicatedOperation ||
          setting.key === "CONTENT_MODERATION_BLOCK_RISK_LEVEL"
        ) {
          continue;
        }
        if (clearKeys[setting.key]) {
          payload.push({ key: setting.key, clear: true });
          continue;
        }
        const value = drafts[setting.key];
        if (
          setting.secret &&
          typeof value === "string" &&
          value.trim() === ""
        ) {
          continue;
        }
        payload.push({
          key: setting.key,
          value: toSubmitValue(setting, value ?? ""),
        });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "配置格式错误");
      return;
    }

    if (payload.length === 0) {
      toast.info("没有需要保存的改动");
      return;
    }

    saveSettings({ settings: payload });
  };

  const updateDraft = (key: SettingKey, value: DraftValue) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    setClearKeys((current) => ({ ...current, [key]: false }));
  };

  const markClear = (key: SettingKey) => {
    setDrafts((current) => ({ ...current, [key]: "" }));
    setClearKeys((current) => ({ ...current, [key]: true }));
  };

  const disabled = isLoading || isSaving || isImporting || isInitializing;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-400 motion-reduce:animate-none">
        <div>
          <h2 className="font-serif text-2xl font-medium tracking-tight">
            系统设置
          </h2>
          <p className="text-sm text-muted-foreground">
            管理支持、审核、登录、支付、模型、存储和邮件等全局配置。动态配置由
            Redis 跨实例缓存，密钥不会在页面回显。
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => initializeDefaults()}
            disabled={disabled}
          >
            {isInitializing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Database className="mr-2 h-4 w-4" />
            )}
            初始化默认配置
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => importEnvSettings({ overwrite: true })}
            disabled={disabled}
          >
            {isImporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            导入当前环境变量
          </Button>
          <Button
            onClick={handleSave}
            disabled={disabled || settings.length === 0}
          >
            {isSaving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存设置
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        已保存配置优先于环境变量；标记为“动态生效”的配置保存后无需重启，通常在 1
        秒内传播到各实例。标记为“需重启”或“需重新构建”的配置，保存后仍要重启服务或重新部署才完整生效。
      </div>

      <Tabs
        defaultValue={SETTING_CATEGORIES[0]?.id ?? "general"}
        className="w-full"
      >
        <TabsList className="h-auto flex-wrap justify-start bg-transparent p-0">
          {SETTING_CATEGORIES.map((category) => (
            <TabsTrigger
              key={category.id}
              value={category.id}
              className="rounded-md border border-transparent px-3 py-2 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {category.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {SETTING_CATEGORIES.map((category) => {
          const categorySettings = settingsByCategory.get(category.id) ?? [];
          return (
            <TabsContent
              key={category.id}
              value={category.id}
              className="mt-6 space-y-4"
            >
              <div>
                <h3 className="font-serif text-lg font-medium">
                  {category.label}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {category.description}
                </p>
              </div>

              {category.id === "moderation" && (
                <ModerationPolicyCard timeZone={timeZone} />
              )}

              {category.id === "general" && siteLogoSetting && (
                <SiteLogoSettingsCard
                  key={`${siteLogoSetting.updatedAt ?? "default"}:${siteLogoSetting.value}`}
                  initialValue={siteLogoSetting.value}
                  source={
                    siteLogoSetting.stored
                      ? "stored"
                      : siteLogoSetting.fromEnv
                        ? "environment"
                        : "default"
                  }
                  disabled={disabled}
                  onSaved={() => loadSettings()}
                />
              )}

              {category.id === "mail" ? notificationModule : null}

              <div className="grid gap-4 lg:grid-cols-2">
                {categorySettings.map((setting) => (
                  <Card
                    key={setting.key}
                    className={
                      setting.key === "CREDIT_PACKAGE_MATRIX" ||
                      setting.key === "CREDIT_TOP_UP_CONFIG" ||
                      setting.key === REFERRAL_REWARD_CONFIG_SETTING_KEY ||
                      setting.key === "DASHBOARD_SUPPORT_CONFIG" ||
                      setting.key === "PAGINATION_PAGE_SIZE_OPTIONS"
                        ? "rounded-lg lg:col-span-2"
                        : "rounded-lg"
                    }
                  >
                    <CardHeader className="space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle className="text-base">
                          {setting.label}
                        </CardTitle>
                        <div className="flex flex-wrap justify-end gap-1">
                          {setting.secret && (
                            <Badge variant="secondary">密钥</Badge>
                          )}
                          {setting.stored ? (
                            <Badge>后台</Badge>
                          ) : setting.fromEnv ? (
                            <Badge variant="secondary">环境变量</Badge>
                          ) : (
                            <Badge variant="outline">未配置</Badge>
                          )}
                          {setting.requiresRestart && (
                            <Badge variant="outline">需重启</Badge>
                          )}
                          {setting.requiresRebuild && (
                            <Badge variant="outline">需重新构建</Badge>
                          )}
                          {!setting.requiresRestart &&
                            !setting.requiresRebuild && (
                              <Badge variant="outline">动态生效</Badge>
                            )}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {setting.description}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2">
                        <Label
                          htmlFor={`setting-${setting.key}`}
                          className="text-[11px] uppercase tracking-widest text-muted-foreground"
                        >
                          {setting.key}
                        </Label>
                        <div className="flex items-center gap-2">
                          <div id={`setting-${setting.key}`} className="flex-1">
                            <SettingInput
                              setting={setting}
                              value={drafts[setting.key] ?? ""}
                              disabled={disabled}
                              onChange={(value) =>
                                updateDraft(setting.key, value)
                              }
                            />
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled={disabled || !setting.configured}
                            title="清空后台配置"
                            onClick={() => markClear(setting.key)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {clearKeys[setting.key] && (
                        <p className="text-xs text-destructive">
                          保存后将清空此项的后台配置，环境变量兜底仍可能生效。
                        </p>
                      )}
                      {setting.valueType === "json" &&
                        setting.exampleValue !== undefined &&
                        !setting.configured && (
                          <p className="text-xs text-muted-foreground">
                            {getJsonSettingHint(setting.key)}
                          </p>
                        )}
                      {setting.updatedAt && (
                        <p className="text-xs text-muted-foreground">
                          最近更新:{" "}
                          {formatDateInTimeZone(
                            setting.updatedAt,
                            "zh",
                            {
                              year: "numeric",
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                            timeZone
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
