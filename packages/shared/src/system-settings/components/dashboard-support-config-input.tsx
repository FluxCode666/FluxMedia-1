/**
 * 控制台账户与支持配置的可视化编辑器。
 *
 * SystemSettingsPanel 在编辑 DASHBOARD_SUPPORT_CONFIG 时使用本组件。组件只维护
 * 表单草稿并向父级回传 JSON，最终可信校验仍由 system-settings 写入边界负责。
 */

import { Button } from "@repo/ui/components/button";
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
import { Textarea } from "@repo/ui/components/textarea";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  type DashboardSupportConfig,
  type DashboardSupportService,
  type DashboardSupportServiceIcon,
  DEFAULT_DASHBOARD_SUPPORT_CONFIG,
  normalizeDashboardSupportConfig,
} from "../../support/dashboard-config";

const SERVICE_ICON_OPTIONS: Array<{
  value: DashboardSupportServiceIcon;
  label: string;
}> = [
  { value: "discord", label: "Discord" },
  { value: "telegram", label: "Telegram" },
  { value: "qq", label: "QQ" },
  { value: "wechat", label: "微信" },
  { value: "twitter", label: "推特" },
  { value: "team", label: "团队介绍" },
  { value: "documentation", label: "文档" },
  { value: "models", label: "模型" },
  { value: "support", label: "客服" },
  { value: "website", label: "网站" },
];

type DashboardSupportConfigInputProps = {
  value: unknown;
  fallbackValue: unknown;
  disabled: boolean;
  onChange: (value: string) => void;
};

type LocalizedFieldProps = {
  label: string;
  value: { zh: string; en: string };
  disabled: boolean;
  multiline?: boolean;
  onChange: (locale: "zh" | "en", value: string) => void;
};

/**
 * 解析父表单初值；字符串解析失败或结构不合法时使用定义中的安全默认配置。
 *
 * @param value 当前设置草稿。
 * @param fallbackValue 设置定义提供的默认值。
 * @returns 可供本地表单继续编辑的完整配置。
 */
function parseInitialConfig(
  value: unknown,
  fallbackValue: unknown
): DashboardSupportConfig {
  if (typeof value === "string") {
    try {
      return normalizeDashboardSupportConfig(JSON.parse(value) as unknown);
    } catch {
      return normalizeDashboardSupportConfig(fallbackValue);
    }
  }
  return normalizeDashboardSupportConfig(
    value ?? fallbackValue ?? DEFAULT_DASHBOARD_SUPPORT_CONFIG
  );
}

/**
 * 生成当前列表中未使用的稳定服务项 ID。
 *
 * @param services 当前服务项。
 * @returns 符合配置 schema 且不与现有项重复的 ID。
 */
function createServiceId(services: DashboardSupportService[]): string {
  const ids = new Set(services.map((service) => service.id));
  let suffix = services.length + 1;
  while (ids.has(`custom-service-${suffix}`)) suffix += 1;
  return `custom-service-${suffix}`;
}

/**
 * 构造一条可以立即编辑和保存的新服务项。
 *
 * @param services 当前服务列表，用于生成唯一 ID。
 * @returns 带双语占位文案和安全站内链接的新服务项。
 */
function createService(
  services: DashboardSupportService[]
): DashboardSupportService {
  return {
    id: createServiceId(services),
    enabled: true,
    icon: "website",
    title: { zh: "新服务", en: "New service" },
    description: { zh: "服务说明", en: "Service description" },
    actionLabel: { zh: "打开", en: "Open" },
    url: "/dashboard",
  };
}

/**
 * 渲染一个中英文成对字段，避免管理员遗漏任一控制台语言。
 */
function LocalizedField({
  label,
  value,
  disabled,
  multiline = false,
  onChange,
}: LocalizedFieldProps) {
  const controlClassName = multiline ? "min-h-20 resize-y" : undefined;
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="grid gap-2 md:grid-cols-2">
        {multiline ? (
          <>
            <Textarea
              className={controlClassName}
              disabled={disabled}
              onChange={(event) => onChange("zh", event.target.value)}
              placeholder="中文"
              value={value.zh}
            />
            <Textarea
              className={controlClassName}
              disabled={disabled}
              onChange={(event) => onChange("en", event.target.value)}
              placeholder="English"
              value={value.en}
            />
          </>
        ) : (
          <>
            <Input
              disabled={disabled}
              onChange={(event) => onChange("zh", event.target.value)}
              placeholder="中文"
              value={value.zh}
            />
            <Input
              disabled={disabled}
              onChange={(event) => onChange("en", event.target.value)}
              placeholder="English"
              value={value.en}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 渲染官方支持与服务入口的结构化编辑器。
 *
 * @param props 父表单草稿、默认值、禁用态与 JSON 回调。
 * @returns 可增删服务项的双语配置表单；不直接持久化数据。
 */
export function DashboardSupportConfigInput({
  value,
  fallbackValue,
  disabled,
  onChange,
}: DashboardSupportConfigInputProps) {
  const [config, setConfig] = useState<DashboardSupportConfig>(() =>
    parseInitialConfig(value, fallbackValue)
  );

  /** 同步本地草稿并把完整 JSON 交回 SystemSettingsPanel。 */
  const commit = (next: DashboardSupportConfig) => {
    setConfig(next);
    onChange(JSON.stringify(next, null, 2));
  };

  /** 更新官方支持对象中的普通字段。 */
  const updateOfficial = (
    patch: Partial<DashboardSupportConfig["officialSupport"]>
  ) => {
    commit({
      ...config,
      officialSupport: { ...config.officialSupport, ...patch },
    });
  };

  /** 更新官方支持的双语字段。 */
  const updateOfficialLocalized = (
    field: "channel" | "description" | "actionLabel",
    locale: "zh" | "en",
    nextValue: string
  ) => {
    updateOfficial({
      [field]: { ...config.officialSupport[field], [locale]: nextValue },
    });
  };

  /** 更新可选二维码地址；清空时从 JSON 中移除字段。 */
  const updateQrCodeUrl = (nextValue: string) => {
    const officialSupport = { ...config.officialSupport };
    if (nextValue.trim()) officialSupport.qrCodeUrl = nextValue;
    else delete officialSupport.qrCodeUrl;
    commit({ ...config, officialSupport });
  };

  /** 按数组索引合并一条服务项草稿。 */
  const updateService = (
    index: number,
    patch: Partial<DashboardSupportService>
  ) => {
    commit({
      ...config,
      services: config.services.map((service, serviceIndex) =>
        serviceIndex === index ? { ...service, ...patch } : service
      ),
    });
  };

  /** 更新服务项的双语字段。 */
  const updateServiceLocalized = (
    index: number,
    field: "title" | "description" | "actionLabel",
    locale: "zh" | "en",
    nextValue: string
  ) => {
    const service = config.services[index];
    if (!service) return;
    updateService(index, {
      [field]: { ...service[field], [locale]: nextValue },
    });
  };

  /** 删除指定服务项；其他项顺序保持不变。 */
  const removeService = (index: number) => {
    commit({
      ...config,
      services: config.services.filter(
        (_service, serviceIndex) => serviceIndex !== index
      ),
    });
  };

  /** 在十二项上限内追加一条安全默认服务项。 */
  const addService = () => {
    if (config.services.length >= 12) return;
    commit({
      ...config,
      services: [...config.services, createService(config.services)],
    });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-lg border bg-muted/10 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-medium">Official Support</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              配置官方渠道、联系入口与可选二维码。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="official-support-enabled">显示</Label>
            <Switch
              checked={config.officialSupport.enabled}
              disabled={disabled}
              id="official-support-enabled"
              onCheckedChange={(enabled) => updateOfficial({ enabled })}
            />
          </div>
        </div>

        <LocalizedField
          disabled={disabled}
          label="渠道名称"
          onChange={(locale, nextValue) =>
            updateOfficialLocalized("channel", locale, nextValue)
          }
          value={config.officialSupport.channel}
        />
        <LocalizedField
          disabled={disabled}
          label="支持说明"
          multiline
          onChange={(locale, nextValue) =>
            updateOfficialLocalized("description", locale, nextValue)
          }
          value={config.officialSupport.description}
        />
        <LocalizedField
          disabled={disabled}
          label="按钮文案"
          onChange={(locale, nextValue) =>
            updateOfficialLocalized("actionLabel", locale, nextValue)
          }
          value={config.officialSupport.actionLabel}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="official-support-url">联系链接</Label>
            <Input
              disabled={disabled}
              id="official-support-url"
              onChange={(event) =>
                updateOfficial({ actionUrl: event.target.value })
              }
              placeholder="/dashboard/support/new 或 https://..."
              value={config.officialSupport.actionUrl}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="official-support-qr-code">二维码图片链接</Label>
            <Input
              disabled={disabled}
              id="official-support-qr-code"
              onChange={(event) => updateQrCodeUrl(event.target.value)}
              placeholder="可留空；支持 /path 或 https://..."
              value={config.officialSupport.qrCodeUrl ?? ""}
            />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="font-medium">Service &amp; Support</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              可选
              QQ、微信、推特和团队介绍等入口；团队介绍请选择对应类型并填写团队页
              URL。服务项按当前顺序展示，最多十二项；关闭后保留配置但不在控制台显示。
            </p>
          </div>
          <Button
            disabled={disabled || config.services.length >= 12}
            onClick={addService}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus />
            添加服务项
          </Button>
        </div>

        <div className="space-y-4">
          {config.services.map((service, index) => (
            <div
              className="space-y-4 rounded-lg border bg-background p-4"
              key={service.id}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <Input
                  aria-label="服务项 ID"
                  className="font-mono text-xs sm:max-w-56"
                  disabled={disabled}
                  readOnly
                  value={service.id}
                />
                <Select
                  disabled={disabled}
                  onValueChange={(value) => {
                    const icon = SERVICE_ICON_OPTIONS.find(
                      (option) => option.value === value
                    )?.value;
                    if (icon) updateService(index, { icon });
                  }}
                  value={service.icon}
                >
                  <SelectTrigger className="sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SERVICE_ICON_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="ml-auto flex items-center gap-2">
                  <Label htmlFor={`service-enabled-${index}`}>显示</Label>
                  <Switch
                    checked={service.enabled}
                    disabled={disabled}
                    id={`service-enabled-${index}`}
                    onCheckedChange={(enabled) =>
                      updateService(index, { enabled })
                    }
                  />
                  <Button
                    aria-label="删除服务项"
                    disabled={disabled}
                    onClick={() => removeService(index)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>

              <LocalizedField
                disabled={disabled}
                label="服务名称"
                onChange={(locale, nextValue) =>
                  updateServiceLocalized(index, "title", locale, nextValue)
                }
                value={service.title}
              />
              <LocalizedField
                disabled={disabled}
                label="服务说明"
                multiline
                onChange={(locale, nextValue) =>
                  updateServiceLocalized(
                    index,
                    "description",
                    locale,
                    nextValue
                  )
                }
                value={service.description}
              />
              <LocalizedField
                disabled={disabled}
                label="按钮文案"
                onChange={(locale, nextValue) =>
                  updateServiceLocalized(
                    index,
                    "actionLabel",
                    locale,
                    nextValue
                  )
                }
                value={service.actionLabel}
              />
              <div className="space-y-2">
                <Label htmlFor={`service-url-${index}`}>
                  目标链接（团队介绍填写团队页 URL）
                </Label>
                <Input
                  disabled={disabled}
                  id={`service-url-${index}`}
                  onChange={(event) =>
                    updateService(index, { url: event.target.value })
                  }
                  placeholder="/dashboard/... 或 https://..."
                  value={service.url}
                />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
