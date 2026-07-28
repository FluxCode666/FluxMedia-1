"use client";

/**
 * 网站 Logo 地址编辑器。
 *
 * 职责：编辑动态 Logo 地址，提供即时预览和与服务端一致的安全校验反馈。
 * 使用方：SystemSettingsPanel 的 SITE_LOGO_URL 配置卡片。
 * 关键依赖：站点品牌纯契约与共享 Input；不读取数据库或发起保存请求。
 */
import { Input } from "@repo/ui/components/input";
import Image from "next/image";
import { useMemo, useState } from "react";

import { DEFAULT_SITE_LOGO_URL, siteLogoUrlSchema } from "../site-branding";

/**
 * 渲染带安全预览的 Logo 地址输入。
 *
 * @param value - 当前字符串草稿；空值表示使用内置默认 Logo。
 * @param inputId - 与外部 Label 关联的稳定输入 ID。
 * @param disabled - 加载或保存期间是否禁用输入。
 * @param onChange - 草稿变化回调，不直接产生服务端副作用。
 * @returns Logo 地址输入、校验提示和 64 像素即时预览。
 * @sideEffects 浏览器请求预览资源；加载失败时记录对应地址的本地状态。
 */
export function SiteLogoUrlInput({
  value,
  inputId,
  disabled,
  onChange,
}: {
  value: string;
  inputId: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const result = useMemo(() => {
    const candidate = value.trim() || DEFAULT_SITE_LOGO_URL;
    return siteLogoUrlSchema.safeParse(candidate);
  }, [value]);
  const previewUrl = result.success ? result.data : null;
  const previewFailed = previewUrl !== null && failedPreviewUrl === previewUrl;

  return (
    <div className="space-y-3">
      <Input
        id={inputId}
        type="url"
        value={value}
        placeholder={DEFAULT_SITE_LOGO_URL}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background">
          {previewUrl && !previewFailed ? (
            <Image
              key={previewUrl}
              src={previewUrl}
              alt="网站 Logo 预览"
              width={56}
              height={56}
              className="size-14 object-contain"
              referrerPolicy="no-referrer"
              unoptimized
              onError={() => setFailedPreviewUrl(previewUrl)}
            />
          ) : (
            <span className="px-1 text-center text-[10px] text-destructive">
              无法预览
            </span>
          )}
        </div>
        <div className="min-w-0 text-xs text-muted-foreground">
          {result.success ? (
            <>
              <p className="font-medium text-foreground">当前预览</p>
              <p className="mt-1 break-all">
                {value.trim() ? "保存后全站动态生效" : "当前使用内置矢量 Logo"}
              </p>
            </>
          ) : (
            <p className="text-destructive">
              {result.error.issues[0]?.message ?? "Logo 地址格式无效"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
