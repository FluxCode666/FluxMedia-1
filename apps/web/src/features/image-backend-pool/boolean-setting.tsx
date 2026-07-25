"use client";

/**
 * 统一媒体号池表单的布尔设置行。
 *
 * 职责：让分组与成员表单共享相同的标签、说明和开关布局；状态仍完全由父表单控制。
 */

import { Label } from "@repo/ui/components/label";
import { Switch } from "@repo/ui/components/switch";

/** 受控布尔设置行所需属性。 */
interface BackendBooleanSettingProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * 渲染带说明文本的受控开关。
 *
 * @param props DOM ID、文案、当前值与更新回调。
 * @returns 可在号池表单中复用的设置行。
 */
export function BackendBooleanSetting({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: BackendBooleanSettingProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
