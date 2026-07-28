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
import Image from "next/image";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { setSiteLogoAction } from "../actions";
import {
  MAX_SITE_LOGO_UPLOAD_BYTES,
  siteLogoUrlSchema,
} from "../site-branding";
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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
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
  const isUploadDisabled = isDisabled || isUploading;

  /**
   * 为所选文件创建本地预览，并在替换或卸载时释放 Blob URL。
   *
   * @sideEffects 创建和撤销浏览器 Blob URL；不上传文件。
   */
  useEffect(() => {
    if (!selectedFile) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  /**
   * 接收文件选择并执行轻量客户端边界校验。
   *
   * @param file - 浏览器选择的候选文件；真实格式由服务端按字节校验。
   * @sideEffects 更新本地预览和错误状态，不写入后端。
   */
  const selectFile = (file: File | null) => {
    setUploadError(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_SITE_LOGO_UPLOAD_BYTES) {
      setSelectedFile(null);
      setUploadError("Logo 文件不能超过 5 MB");
      return;
    }
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!["png", "svg", "ico"].includes(extension ?? "")) {
      setSelectedFile(null);
      setUploadError("请选择 PNG、SVG 或 ICO 文件");
      return;
    }
    setSelectedFile(file);
  };

  /**
   * 把原始文件交给管理员上传 Route；服务端保持原格式，前台由所在位置控制尺寸。
   *
   * @sideEffects 发送 multipart 请求、更新 Logo URL 草稿并刷新管理快照。
   * @failure 网络、权限或服务端校验失败时保留当前有效 Logo。
   */
  const uploadFile = async () => {
    if (!selectedFile) {
      setUploadError("请先选择 PNG、SVG 或 ICO 文件");
      return;
    }
    setIsUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("clientRequestId", crypto.randomUUID());
      formData.append("file", selectedFile);
      const response = await fetch("/api/admin/site-branding/logo", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isLogoUploadResponse(payload)) {
        const message =
          isLogoUploadError(payload) && payload.error
            ? payload.error
            : "网站 Logo 上传失败";
        throw new Error(message);
      }
      setDraft(payload.logoUrl);
      setSelectedFile(null);
      toast.success("网站 Logo 已上传");
      onSaved();
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "网站 Logo 上传失败"
      );
    } finally {
      setIsUploading(false);
    }
  };

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
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-h-24 items-center justify-center rounded-md border bg-background p-3">
            <Image
              src={previewUrl ?? (draft.trim() || "/api/site-logo")}
              alt="网站 Logo 预览"
              width={160}
              height={80}
              className="max-h-20 max-w-full object-contain"
              unoptimized
            />
          </div>
          <div className="flex min-h-24 items-center justify-center rounded-md bg-slate-950 p-3">
            <Image
              src={previewUrl ?? (draft.trim() || "/api/site-logo")}
              alt=""
              aria-hidden="true"
              width={160}
              height={80}
              className="max-h-20 max-w-full object-contain"
              unoptimized
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="setting-site-logo-file">上传 Logo 文件</Label>
          <input
            id="setting-site-logo-file"
            type="file"
            accept=".png,.svg,.ico,image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
            disabled={isUploadDisabled}
            onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            className="block w-full cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            支持 PNG、SVG、ICO，单文件不超过 5
            MB。文件内容保持原格式，展示时按所在位置尺寸缩放。
          </p>
          {selectedFile ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              已选择：{selectedFile.name}
            </p>
          ) : null}
          {uploadError ? (
            <p className="text-sm text-destructive" role="alert">
              {uploadError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={isUploadDisabled || !selectedFile}
              onClick={uploadFile}
            >
              {isUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {isUploading ? "上传中" : "上传文件"}
            </Button>
          </div>
        </div>
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

/** 判断上传成功响应是否包含可渲染 Logo URL。 */
function isLogoUploadResponse(
  value: unknown
): value is { logoUrl: string; replayed: boolean } {
  return (
    isRecord(value) &&
    typeof value.logoUrl === "string" &&
    typeof value.replayed === "boolean"
  );
}

/** 判断上传失败响应是否包含安全错误文案。 */
function isLogoUploadError(value: unknown): value is { error?: string } {
  return (
    isRecord(value) &&
    (value.error === undefined || typeof value.error === "string")
  );
}

/** 把未知 JSON 值收窄为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
