"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  ALLOWED_IMAGE_TYPES,
  generateAvatarKey,
  getAvatarUrl,
  getSignedUploadUrlAction,
  MAX_FILE_SIZE,
} from "@repo/shared/storage";
import { getMyPlanAction } from "@repo/shared/subscription/actions/get-user-plan";
import type { PlanCapabilitySnapshot } from "@repo/shared/subscription/services/plan-capabilities";
import { USER_TIME_ZONE_OPTIONS } from "@repo/shared/time-zone";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/ui/components/avatar";
import { Button } from "@repo/ui/components/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/ui/components/form";
import { Input } from "@repo/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/components/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/ui/components/tabs";
import { Camera, Loader2 } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import {
  updateProfileAction,
  updateTimeZoneAction,
} from "@/features/settings/actions";
import { updateProfileSchema } from "@/features/settings/schemas";
import { usePathname, useRouter } from "@/i18n/routing";

import {
  isAvatarFileSizeAllowed,
  resolveAvatarMaxFileSizeBytes,
} from "./avatar-upload-limit";
import { SecuritySection } from "./security-section";

interface SettingsProfileViewProps {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null | undefined;
    timeZone: string | null;
    defaultTimeZone: string;
  };
}

type FormValues = z.infer<typeof updateProfileSchema>;
const INHERIT_TIME_ZONE_VALUE = "__inherit_app_time_zone__";

/** Tab 触发器统一样式：单色边框激活态 + 150ms 颜色过渡 */
const tabTriggerClass =
  "rounded-md border border-transparent px-4 py-2 transition-colors duration-150 data-[state=active]:border-foreground/20 data-[state=active]:bg-foreground/5 data-[state=active]:text-foreground data-[state=active]:shadow-none";

/** 设置分区节标题：uppercase 小标签 + 下边框分隔（对齐参考项目排版语言） */
const sectionTitleClass =
  "text-xs font-medium uppercase tracking-[1.2px] text-muted-foreground";

/** 表单字段标签：uppercase 小字距；不带颜色以保留 FormLabel 错误态变红 */
const fieldLabelClass = "text-xs uppercase tracking-[0.6px]";

/**
 * 设置行 hover 微提亮：负外边距抵消内边距，hover 背景外扩而内容不位移。
 * 仅作视觉反馈，不改变行内交互。
 */
const settingRowClass =
  "-mx-3 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-muted/30";

export function SettingsProfileView({ user }: SettingsProfileViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const t = useTranslations("Settings");
  const tTabs = useTranslations("Settings.tabs");

  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = useParams();
  const [isChangingLocale, startLocaleTransition] = useTransition();

  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [selectedTimeZone, setSelectedTimeZone] = useState(
    user.timeZone ?? INHERIT_TIME_ZONE_VALUE
  );
  const [capabilities, setCapabilities] =
    useState<PlanCapabilitySnapshot | null>(null);
  const avatarMaxFileSizeBytes = resolveAvatarMaxFileSizeBytes(
    capabilities,
    MAX_FILE_SIZE
  );
  const normalizeTab = useCallback((value: string | null) => {
    if (value === "security" || value === "account") {
      return value;
    }
    return "account";
  }, []);
  const [activeTab, setActiveTab] = useState(() =>
    normalizeTab(searchParams.get("tab"))
  );
  const lastAppliedTabParamRef = useRef(searchParams.get("tab"));

  const handleLanguageChange = (newLocale: string) => {
    startLocaleTransition(() => {
      router.replace(
        // @ts-expect-error Current route params always match the current pathname.
        { pathname, params },
        { locale: newLocale }
      );
    });
  };

  const getInitials = (name: string) => {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const currentAvatarUrl = avatarPreview ?? getAvatarUrl(user.image);

  const form = useForm<FormValues>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      name: user.name,
    },
  });

  useEffect(() => {
    void getMyPlanAction().then((result) => {
      setCapabilities(result?.data?.capabilities ?? null);
    });
  }, []);

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab === "billing") {
      router.replace("/dashboard/wallet");
      return;
    }
    if (requestedTab === "usage") {
      router.replace("/dashboard/history");
      return;
    }
    if (requestedTab === "external-api") {
      router.replace("/dashboard/external-api");
      return;
    }
    if (requestedTab === lastAppliedTabParamRef.current) return;
    lastAppliedTabParamRef.current = requestedTab;
    if (!requestedTab) return;
    setActiveTab(normalizeTab(requestedTab));
  }, [searchParams, normalizeTab, router]);

  const { execute: executeUpdateProfile, isPending } = useAction(
    updateProfileAction,
    {
      onSuccess: ({ data }) => {
        if (data?.message) {
          toast.success(data.message);
        }
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError);
        }
        if (error.validationErrors) {
          const errors = Object.values(error.validationErrors).flat();
          toast.error(errors.join(", ") || t("errors.validationFailed"));
        }
      },
    }
  );

  const { execute: executeUpdateTimeZone, isPending: isUpdatingTimeZone } =
    useAction(updateTimeZoneAction, {
      onSuccess: ({ data }) => {
        setSelectedTimeZone(data?.timeZone ?? INHERIT_TIME_ZONE_VALUE);
        toast.success(t("timeZone.saved"));
        router.refresh();
      },
      onError: ({ error }) => {
        toast.error(error.serverError || t("timeZone.error"));
      },
    });

  const onSubmit = (values: FormValues) => {
    executeUpdateProfile(values);
  };

  /** 保存当前时区选择；继承选项转换为数据库 NULL。 */
  const handleTimeZoneSave = () => {
    executeUpdateTimeZone({
      timeZone:
        selectedTimeZone === INHERIT_TIME_ZONE_VALUE ? null : selectedTimeZone,
    });
  };

  const handleAvatarClick = () => {
    if (!isUploadingAvatar) {
      fileInputRef.current?.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (
      !ALLOWED_IMAGE_TYPES.includes(
        file.type as (typeof ALLOWED_IMAGE_TYPES)[number]
      )
    ) {
      toast.error(
        t("errors.unsupportedFileType", {
          types: ALLOWED_IMAGE_TYPES.join(", "),
        })
      );
      return;
    }

    if (!isAvatarFileSizeAllowed(file.size, avatarMaxFileSizeBytes)) {
      toast.error(
        t("errors.fileTooLarge", { size: avatarMaxFileSizeBytes / 1024 / 1024 })
      );
      return;
    }

    setIsUploadingAvatar(true);

    try {
      const localPreviewUrl = URL.createObjectURL(file);
      setAvatarPreview(localPreviewUrl);

      const key = generateAvatarKey(user.id, file);

      const uploadUrlResult = await getSignedUploadUrlAction({
        key,
        contentType: file.type as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
      });

      if (!uploadUrlResult?.data?.uploadUrl) {
        throw new Error(t("errors.uploadFailed"));
      }
      const signedMaxFileSizeBytes = resolveAvatarMaxFileSizeBytes(
        {
          limits: {
            maxFileSizeBytes: uploadUrlResult.data.maxFileSizeBytes,
          },
        },
        avatarMaxFileSizeBytes
      );
      if (!isAvatarFileSizeAllowed(file.size, signedMaxFileSizeBytes)) {
        throw new Error(
          t("errors.fileTooLarge", {
            size: signedMaxFileSizeBytes / 1024 / 1024,
          })
        );
      }

      const uploadResponse = await fetch(uploadUrlResult.data.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!uploadResponse.ok) {
        throw new Error(t("errors.fileUploadFailed"));
      }

      executeUpdateProfile({ image: uploadUrlResult.data.key });
      toast.success(t("success.avatarUpdated"));
    } catch (error) {
      console.error("Avatar upload error:", error);
      toast.error(
        error instanceof Error ? error.message : t("errors.avatarUploadError")
      );
      setAvatarPreview(null);
    } finally {
      setIsUploadingAvatar(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div className="max-w-4xl space-y-8">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(normalizeTab(value))}
        className="w-full"
      >
        <div className="border-b border-border/60 pb-2">
          <TabsList className="h-auto gap-1 bg-transparent p-0">
            <TabsTrigger value="account" className={tabTriggerClass}>
              {tTabs("account")}
            </TabsTrigger>
            <TabsTrigger value="security" className={tabTriggerClass}>
              {tTabs("security")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="account"
          className="mt-8 space-y-8 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <section className="space-y-6">
            <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("general.title")}</h2>
              <Button
                type="submit"
                form="profile-form"
                size="sm"
                disabled={isPending}
              >
                {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("general.save")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("general.description")}
            </p>

            <Form {...form}>
              <form
                id="profile-form"
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-6"
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className={fieldLabelClass}>
                        {t("general.name")}
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t("general.namePlaceholder")}
                          disabled={isPending}
                          className="max-w-md"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        {t("general.nameDescription")}
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-2">
                  <label
                    htmlFor="settings-email"
                    className="block text-xs font-medium uppercase leading-none tracking-[0.6px] text-muted-foreground"
                  >
                    {t("general.email")}
                  </label>
                  <Input
                    id="settings-email"
                    type="email"
                    value={user.email}
                    disabled
                    className="max-w-md bg-muted"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t("general.emailDescription")}
                  </p>
                </div>
              </form>
            </Form>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("avatar.title")}</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("avatar.description")}
            </p>

            <div className="flex flex-col items-center space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={handleFileChange}
                disabled={isUploadingAvatar}
              />

              <button
                type="button"
                onClick={handleAvatarClick}
                disabled={isUploadingAvatar}
                className="group relative cursor-pointer disabled:cursor-not-allowed"
              >
                <Avatar className="h-24 w-24 transition-opacity group-hover:opacity-80 group-disabled:opacity-60">
                  <AvatarImage src={currentAvatarUrl} alt={user.name} />
                  <AvatarFallback className="bg-foreground text-background text-2xl">
                    {getInitials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 group-disabled:opacity-100">
                  {isUploadingAvatar ? (
                    <Loader2 className="h-6 w-6 animate-spin text-white" />
                  ) : (
                    <Camera className="h-6 w-6 text-white" />
                  )}
                </div>
              </button>

              <p className="text-sm text-muted-foreground">
                {isUploadingAvatar
                  ? t("avatar.uploading")
                  : t("avatar.supportedFormats", {
                      size: avatarMaxFileSizeBytes / 1024 / 1024,
                    })}
              </p>
            </div>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("language.title")}</h2>
            </div>
            <div
              className={`flex items-center justify-between gap-4 ${settingRowClass}`}
            >
              <p className="text-sm text-muted-foreground">
                {t("language.description")}
              </p>

              <Select
                value={locale}
                onValueChange={handleLanguageChange}
                disabled={isChangingLocale}
              >
                <SelectTrigger className="w-40">
                  <SelectValue placeholder={t("language.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="zh">中文</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </section>

          <section className="space-y-6">
            <div className="border-b border-border/60 pb-2">
              <h2 className={sectionTitleClass}>{t("timeZone.title")}</h2>
            </div>
            <div
              className={`flex flex-col gap-4 md:flex-row md:items-center md:justify-between ${settingRowClass}`}
            >
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  {t("timeZone.description")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("timeZone.effective", {
                    timeZone: user.timeZone ?? user.defaultTimeZone,
                  })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedTimeZone}
                  onValueChange={setSelectedTimeZone}
                  disabled={isUpdatingTimeZone}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder={t("timeZone.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT_TIME_ZONE_VALUE}>
                      {t("timeZone.inherit", {
                        timeZone: user.defaultTimeZone,
                      })}
                    </SelectItem>
                    {user.timeZone &&
                      !USER_TIME_ZONE_OPTIONS.some(
                        (timeZone) => timeZone === user.timeZone
                      ) && (
                        <SelectItem value={user.timeZone}>
                          {user.timeZone}
                        </SelectItem>
                      )}
                    {USER_TIME_ZONE_OPTIONS.map((timeZone) => (
                      <SelectItem key={timeZone} value={timeZone}>
                        {timeZone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTimeZoneSave}
                  disabled={
                    isUpdatingTimeZone ||
                    selectedTimeZone ===
                      (user.timeZone ?? INHERIT_TIME_ZONE_VALUE)
                  }
                >
                  {isUpdatingTimeZone && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t("timeZone.save")}
                </Button>
              </div>
            </div>
          </section>
        </TabsContent>

        <TabsContent
          value="security"
          className="mt-8 animate-in fade-in duration-300 motion-reduce:animate-none"
        >
          <SecuritySection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
