"use client";

/**
 * 网站 Logo 专用设置卡片。
 *
 * 职责：承载 Logo 草稿、预览、专用保存与恢复默认交互。
 * 使用方：SystemSettingsPanel 的“基础”分类。
 * 关键依赖：settings.setSiteLogo 的 Server Action；不复用通用批量设置写入口。
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
import { Loader2, RotateCcw, Save } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { setSiteLogoAction } from "../actions";
import { siteLogoUrlSchema } from "../site-branding";
import { SiteLogoUrlInput } from "./site-logo-url-input";

/**
 * 渲染独立于通用批量保存的 Logo 设置卡片。
 *
 * @param initialValue - 后台快照当前值；未配置时为空字符串。
 * @param source - 当前值来源，用于向管理员解释覆盖优先级。
 * @param disabled - 系统设置快照加载或其他批量操作期间是否禁用。
 * @param onSaved - 专用保存成功后的父级刷新回调。
 * @returns 带即时预览、保存和恢复默认按钮的设置卡片。
 * @sideEffects 调用 Logo 专用 Server Action，成功后显示提示并刷新设置快照。
 */
export function SiteLogoSettingsCard({
  initialValue,
  source,
  disabled,
  onSaved,
}: {
  initialValue: string;
  source: "stored" | "environment" | "default";
  disabled: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const { execute, isPending } = useAction(setSiteLogoAction, {
    onSuccess: ({ data }) => {
      if (data?.message) toast.success(data.message);
      onSaved();
    },
    onError: ({ error }) => {
      toast.error(error.serverError || "网站 Logo 保存失败");
    },
  });
  const isDisabled = disabled || isPending;

  /**
   * 校验当前草稿并交给专用 Action。
   *
   * @returns 无返回值；空白草稿等价于恢复默认。
   * @sideEffects 可能显示校验提示，或发起一次专用 Server Action。
   */
  const saveDraft = () => {
    const candidate = draft.trim();
    if (!candidate) {
      execute({ logoUrl: null });
      return;
    }
    const parsed = siteLogoUrlSchema.safeParse(candidate);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Logo 地址格式无效");
      return;
    }
    execute({ logoUrl: parsed.data });
  };

  return (
    <Card className="rounded-lg">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base">网站 Logo</CardTitle>
          <Badge variant={source === "stored" ? "default" : "outline"}>
            {source === "stored"
              ? "后台"
              : source === "environment"
                ? "环境变量"
                : "内置默认"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          统一用于营销导航、认证页、控制台、首页页脚与 SEO
          结构化数据。保存后无需重启。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label
            htmlFor="setting-site-logo-url"
            className="text-[11px] uppercase tracking-widest text-muted-foreground"
          >
            SITE_LOGO_URL
          </Label>
          <div>
            <SiteLogoUrlInput
              value={draft}
              inputId="setting-site-logo-url"
              disabled={isDisabled}
              onChange={setDraft}
            />
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isDisabled}
            onClick={() => execute({ logoUrl: null })}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            恢复默认
          </Button>
          <Button type="button" disabled={isDisabled} onClick={saveDraft}>
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            保存 Logo
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
