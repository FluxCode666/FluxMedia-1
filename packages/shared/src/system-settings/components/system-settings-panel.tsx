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

const PLAN_OPTIONS = [
  { value: "free", label: "Free" },
  { value: "starter", label: "Starter" },
  { value: "pro", label: "Pro" },
  { value: "ultra", label: "Ultra" },
  { value: "enterprise", label: "Enterprise" },
] as const;

const PLAN_REQUIREMENT_OPTIONS = [
  { value: "none", label: "不限制" },
  ...PLAN_OPTIONS,
] as const;

const QUEUE_PRIORITY_OPTIONS = [
  { value: "normal", label: "普通" },
  { value: "priority", label: "优先" },
  { value: "highest", label: "最高" },
] as const;

const FEATURE_ROWS = [
  {
    key: "imageGeneration.text",
    label: "文生图",
    description: "页面/API 文本生成图片",
  },
  {
    key: "imageGeneration.edit",
    label: "图生图/编辑",
    description: "上传参考图、编辑图片",
  },
  {
    key: "imageGeneration.mask",
    label: "蒙版编辑",
    description: "页面使用蒙版进行局部重绘与编辑",
  },
  {
    key: "imageGeneration.video",
    label: "视频生成",
    description: "页面生成视频并查询任务结果",
  },
  {
    key: "imageGeneration.batch",
    label: "批量生成",
    description: "一次请求生成多张",
  },
  {
    key: "promptOptimization.control",
    label: "关闭提示词优化",
    description: "允许用户控制 prompt_optimization",
  },
  {
    key: "backendGroups.select",
    label: "选择后端分组",
    description: "允许选择平台后端分组",
  },
  {
    key: "externalApi.keys.manage",
    label: "管理外接 API Key",
    description: "本站对外 API Key 管理",
  },
  {
    key: "externalApi.models.list",
    label: "外接 /v1/models",
    description: "允许模型列表接口",
  },
  {
    key: "externalApi.images.generate",
    label: "外接文生图",
    description: "允许 /v1/images/generations",
  },
  {
    key: "externalApi.images.edit",
    label: "外接图片编辑",
    description: "允许 /v1/images/edits",
  },
  {
    key: "externalApi.images.mask",
    label: "外接蒙版编辑",
    description: "允许 /v1/images/edits 携带 mask",
  },
  {
    key: "externalApi.images.batch",
    label: "外接批量图片",
    description: "允许外接图片接口一次生成多张",
  },
  {
    key: "externalApi.videos.generate",
    label: "外接视频生成",
    description: "允许外部媒体 API 创建和查询视频任务",
  },
  {
    key: "externalApi.streaming",
    label: "外接流式",
    description: "允许 stream=true",
  },
  {
    key: "moderation.blocking",
    label: "审核拦截",
    description: "本站内容审核是否对该套餐生效",
  },
  {
    key: "moderation.onlyFailureSettlement",
    label: "审核失败只扣审核积分",
    description: "审核拦截后只结算审核成本",
  },
] as const;

const LIMIT_ROWS = [
  {
    key: "monthlyCredits",
    label: "月积分配额",
    description: "Free 为一次性额度，订阅为每月额度",
    inputMode: "numeric",
  },
  {
    key: "imageGenerationConcurrency",
    label: "生图并发",
    description: "单用户图片生成并发上限",
    inputMode: "numeric",
  },
  {
    key: "maxFileMb",
    label: "单文件大小 MB",
    description: "单个上传文件大小上限",
    inputMode: "decimal",
  },
  {
    key: "maxUploadMb",
    label: "单次上传总量 MB",
    description: "一次编辑/对话请求的总上传上限",
    inputMode: "decimal",
  },
  {
    key: "maxBatchCount",
    label: "批量张数",
    description: "n/count 最大值",
    inputMode: "numeric",
  },
  {
    key: "maxEditImages",
    label: "编辑参考图数",
    description: "图生图/编辑最多参考图数量",
    inputMode: "numeric",
  },
  {
    key: "queuePriority",
    label: "队列优先级",
    description: "调度队列优先级",
    inputMode: "select",
  },
] as const;

type PlanValue = (typeof PLAN_OPTIONS)[number]["value"];
type PlanRequirementValue = (typeof PLAN_REQUIREMENT_OPTIONS)[number]["value"];
type QueuePriorityValue = (typeof QUEUE_PRIORITY_OPTIONS)[number]["value"];
type FeatureKey = (typeof FEATURE_ROWS)[number]["key"];
type LimitKey = (typeof LIMIT_ROWS)[number]["key"];

type CapabilityMatrixDraft = {
  version: 1;
  features: Record<FeatureKey, PlanValue>;
  limits: Record<PlanValue, Record<LimitKey, string | number>>;
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
  requiresPlan: PlanRequirementValue;
  allowQuantity: boolean;
  maxQuantity: number;
  creemProductId: string;
  pricesByPlan: Record<PlanValue, number>;
  creemProductIdsByPlan: Record<PlanValue, string>;
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

function formatJsonExample(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordValue(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
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

function asPlan(value: unknown, fallback: PlanValue): PlanValue {
  return PLAN_OPTIONS.some((option) => option.value === value)
    ? (value as PlanValue)
    : fallback;
}

function asPlanRequirement(
  value: unknown,
  fallback: PlanRequirementValue
): PlanRequirementValue {
  return PLAN_REQUIREMENT_OPTIONS.some((option) => option.value === value)
    ? (value as PlanRequirementValue)
    : fallback;
}

function asQueuePriority(
  value: unknown,
  fallback: QueuePriorityValue
): QueuePriorityValue {
  return QUEUE_PRIORITY_OPTIONS.some((option) => option.value === value)
    ? (value as QueuePriorityValue)
    : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
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

function normalizePlanNumberMap(
  value: unknown,
  fallbackValue: unknown,
  fallbackNumber: number
) {
  const raw = isRecord(value) ? value : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};

  return Object.fromEntries(
    PLAN_OPTIONS.map((plan) => [
      plan.value,
      numberValue(
        raw[plan.value],
        numberValue(fallback[plan.value], fallbackNumber)
      ),
    ])
  ) as Record<PlanValue, number>;
}

function normalizePlanStringMap(value: unknown, fallbackValue: unknown) {
  const raw = isRecord(value) ? value : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};

  return Object.fromEntries(
    PLAN_OPTIONS.map((plan) => [
      plan.value,
      stringValue(raw[plan.value], stringValue(fallback[plan.value])),
    ])
  ) as Record<PlanValue, string>;
}

function normalizeCapabilityMatrixDraft(
  rawValue: DraftValue,
  fallbackValue: unknown
): CapabilityMatrixDraft {
  const parsedRaw = parseJsonDraft(rawValue);
  const raw = isRecord(parsedRaw) ? parsedRaw : {};
  const fallback = isRecord(fallbackValue) ? fallbackValue : {};
  const rawFeatures = isRecord(raw.features) ? raw.features : {};
  const fallbackFeatures = isRecord(fallback.features) ? fallback.features : {};
  const rawLimits = isRecord(raw.limits) ? raw.limits : {};
  const fallbackLimits = isRecord(fallback.limits) ? fallback.limits : {};

  const features = Object.fromEntries(
    FEATURE_ROWS.map((row) => [
      row.key,
      asPlan(rawFeatures[row.key], asPlan(fallbackFeatures[row.key], "free")),
    ])
  ) as CapabilityMatrixDraft["features"];

  const limits = Object.fromEntries(
    PLAN_OPTIONS.map((plan) => {
      const rawPlanLimits = recordValue(rawLimits, plan.value);
      const fallbackPlanLimits = recordValue(fallbackLimits, plan.value);

      const entries = LIMIT_ROWS.map((row) => {
        if (row.key === "queuePriority") {
          return [
            row.key,
            asQueuePriority(
              rawPlanLimits[row.key],
              asQueuePriority(fallbackPlanLimits[row.key], "normal")
            ),
          ] as const;
        }

        return [
          row.key,
          numberValue(
            rawPlanLimits[row.key],
            numberValue(fallbackPlanLimits[row.key], 1)
          ),
        ] as const;
      });

      return [plan.value, Object.fromEntries(entries)] as const;
    })
  ) as CapabilityMatrixDraft["limits"];

  return {
    version: 1,
    features,
    limits,
  };
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
        const fallbackRequiresPlan = asPlanRequirement(
          fallback.requiresPlan,
          "none"
        );
        const requiresPlan = asPlanRequirement(
          rawPackage.requiresPlan,
          fallbackRequiresPlan
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
          requiresPlan,
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
          pricesByPlan: normalizePlanNumberMap(
            rawPackage.pricesByPlan,
            fallback.pricesByPlan,
            price
          ),
          creemProductIdsByPlan: normalizePlanStringMap(
            rawPackage.creemProductIdsByPlan,
            fallback.creemProductIdsByPlan
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
    packages: matrix.packages.map((pkg) => {
      const pricesByPlan = Object.fromEntries(
        PLAN_OPTIONS.map((plan) => [plan.value, pkg.pricesByPlan[plan.value]])
      );
      const creemProductIdsByPlan = Object.fromEntries(
        PLAN_OPTIONS.map((plan) => [
          plan.value,
          pkg.creemProductIdsByPlan[plan.value].trim(),
        ]).filter(([, value]) => Boolean(value))
      );

      return {
        id: pkg.id.trim(),
        name: pkg.name.trim() || pkg.id.trim(),
        description: pkg.description,
        credits: Number(pkg.credits) || 1,
        price: Number(pkg.price) || 1,
        currency: pkg.currency.trim().toUpperCase() || "CNY",
        popular: pkg.popular,
        visible: pkg.visible,
        ...(pkg.requiresPlan !== "none"
          ? { requiresPlan: pkg.requiresPlan }
          : {}),
        allowQuantity: pkg.allowQuantity,
        maxQuantity: Number(pkg.maxQuantity) || 1,
        ...(pkg.creemProductId.trim()
          ? { creemProductId: pkg.creemProductId.trim() }
          : {}),
        pricesByPlan,
        ...(Object.keys(creemProductIdsByPlan).length > 0
          ? { creemProductIdsByPlan }
          : {}),
      };
    }),
  };
}

function getJsonSettingHint(key: string) {
  if (key === "PAGINATION_PAGE_SIZE_OPTIONS") {
    return "默认允许每页 10、20、50 条；固定默认值 20 必须保留。保存后所有列表的新请求动态生效。";
  }
  if (key === "PLAN_CAPABILITY_MATRIX") {
    return "留空表示使用代码默认矩阵，并继续兼容旧上传/月积分配置。后台矩阵保存后会写入 JSON；功能门槛按最低套餐生效，高级套餐自动包含低级套餐能力。";
  }
  if (key === "CREDIT_PACKAGE_MATRIX") {
    return "留空表示使用代码默认积分包。占位内容只是示例，填写 JSON 后保存才会启用自定义积分包；pricesByPlan 可按套餐配置不同价格，Creem 按套餐定价时需配置对应产品 ID。";
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

  if (setting.key === "PLAN_CAPABILITY_MATRIX") {
    return (
      <PlanCapabilityMatrixInput
        value={value}
        fallbackValue={setting.exampleValue}
        disabled={disabled}
        onChange={onChange}
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

function MatrixSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="h-9 min-w-24">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlanCapabilityMatrixInput({
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
    () => normalizeCapabilityMatrixDraft(value, fallbackValue),
    [value, fallbackValue]
  );
  const preview = useMemo(() => JSON.stringify(matrix, null, 2), [matrix]);

  const updateMatrix = (next: CapabilityMatrixDraft) => {
    onChange(JSON.stringify(next, null, 2));
  };

  const updateFeature = (key: FeatureKey, plan: PlanValue) => {
    updateMatrix({
      ...matrix,
      features: {
        ...matrix.features,
        [key]: plan,
      },
    });
  };

  const updateLimit = (plan: PlanValue, key: LimitKey, nextValue: string) => {
    updateMatrix({
      ...matrix,
      limits: {
        ...matrix.limits,
        [plan]: {
          ...matrix.limits[plan],
          [key]: key === "queuePriority" ? nextValue : Number(nextValue),
        },
      },
    });
  };

  return (
    <div className="space-y-5">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        按最低套餐配置功能门槛；Starter/Pro/Ultra/Enterprise
        自动包含更低套餐能力。并发、上传大小、月积分、批量张数和参考图数量在这里统一配置。
      </div>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            功能门槛
          </h4>
          <p className="text-xs text-muted-foreground">
            选择启用某项能力所需的最低套餐。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-56 px-3 py-2 text-left font-medium">能力</th>
                <th className="px-3 py-2 text-left font-medium">说明</th>
                <th className="w-36 px-3 py-2 text-left font-medium">
                  最低套餐
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {FEATURE_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2 font-medium">{row.label}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.description}
                  </td>
                  <td className="px-3 py-2">
                    <MatrixSelect
                      value={matrix.features[row.key]}
                      options={PLAN_OPTIONS}
                      disabled={disabled}
                      onChange={(nextValue) =>
                        updateFeature(row.key, nextValue as PlanValue)
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <h4 className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            套餐限制
          </h4>
          <p className="text-xs text-muted-foreground">
            管理 Ultra 等套餐的并发、上传大小、月积分和请求数量限制。
          </p>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="w-52 px-3 py-2 text-left font-medium">限制项</th>
                {PLAN_OPTIONS.map((plan) => (
                  <th
                    key={plan.value}
                    className="w-36 px-3 py-2 text-left font-medium"
                  >
                    {plan.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {LIMIT_ROWS.map((row) => (
                <tr key={row.key}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{row.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.description}
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => {
                    const currentValue = matrix.limits[plan.value][row.key];
                    return (
                      <td key={plan.value} className="px-3 py-2 align-top">
                        {row.key === "queuePriority" ? (
                          <MatrixSelect
                            value={String(currentValue)}
                            options={QUEUE_PRIORITY_OPTIONS}
                            disabled={disabled}
                            onChange={(nextValue) =>
                              updateLimit(plan.value, row.key, nextValue)
                            }
                          />
                        ) : (
                          <Input
                            type="number"
                            min="1"
                            step={row.inputMode === "decimal" ? "0.1" : "1"}
                            value={String(currentValue)}
                            disabled={disabled}
                            className="h-9 min-w-28"
                            onChange={(event) =>
                              updateLimit(
                                plan.value,
                                row.key,
                                event.target.value
                              )
                            }
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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

  const updatePlanPrice = (index: number, plan: PlanValue, price: string) => {
    const pkg = matrix.packages[index];
    if (!pkg) return;
    updatePackage(index, {
      pricesByPlan: {
        ...pkg.pricesByPlan,
        [plan]: Number(price),
      },
    });
  };

  const updatePlanCreemProductId = (
    index: number,
    plan: PlanValue,
    productId: string
  ) => {
    const pkg = matrix.packages[index];
    if (!pkg) return;
    updatePackage(index, {
      creemProductIdsByPlan: {
        ...pkg.creemProductIdsByPlan,
        [plan]: productId,
      },
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
          requiresPlan: "none",
          allowQuantity: false,
          maxQuantity: 1,
          creemProductId: "",
          pricesByPlan: Object.fromEntries(
            PLAN_OPTIONS.map((plan) => [plan.value, 10])
          ) as Record<PlanValue, number>,
          creemProductIdsByPlan: Object.fromEntries(
            PLAN_OPTIONS.map((plan) => [plan.value, ""])
          ) as Record<PlanValue, string>,
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
        可使用各币种对应的预建产品，按套餐定价时需填写对应产品 ID。
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
                兜底价格
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
                最低可购买套餐
              </Label>
              <MatrixSelect
                value={pkg.requiresPlan}
                options={PLAN_REQUIREMENT_OPTIONS}
                disabled={disabled}
                onChange={(nextValue) =>
                  updatePackage(index, {
                    requiresPlan: nextValue as PlanRequirementValue,
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
                Creem 兜底产品 ID
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

          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="w-40 px-3 py-2 text-left font-medium">套餐</th>
                  {PLAN_OPTIONS.map((plan) => (
                    <th
                      key={plan.value}
                      className="w-40 px-3 py-2 text-left font-medium"
                    >
                      {plan.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                <tr>
                  <td className="px-3 py-2 font-medium">价格</td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2">
                      <Input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={String(pkg.pricesByPlan[plan.value])}
                        disabled={disabled}
                        className="h-9 min-w-28"
                        onChange={(event) =>
                          updatePlanPrice(index, plan.value, event.target.value)
                        }
                      />
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="px-3 py-2">
                    <div className="font-medium">Creem 产品 ID</div>
                    <div className="text-xs text-muted-foreground">
                      Epay 可留空
                    </div>
                  </td>
                  {PLAN_OPTIONS.map((plan) => (
                    <td key={plan.value} className="px-3 py-2">
                      <Input
                        value={pkg.creemProductIdsByPlan[plan.value]}
                        disabled={disabled}
                        className="h-9 min-w-36"
                        placeholder="可选"
                        onChange={(event) =>
                          updatePlanCreemProductId(
                            index,
                            plan.value,
                            event.target.value
                          )
                        }
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
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
                      setting.key === "PLAN_CAPABILITY_MATRIX" ||
                      setting.key === "CREDIT_PACKAGE_MATRIX" ||
                      setting.key === "CREDIT_TOP_UP_CONFIG" ||
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
