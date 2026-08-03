/**
 * 控制台账户支持区的可配置内容契约。
 *
 * 系统设置写入、UOL 读取和 Web 控制台共用本文件，确保多语言文案、链接协议与
 * 服务项数量、社交渠道和团队介绍链接在进入渲染层前已经收窄。这里不依赖数据库，
 * 可由 Vitest 直接验证。
 */
import { z } from "zod";

const localizedTextSchema = z
  .object({
    zh: z.string().trim().min(1).max(120),
    en: z.string().trim().min(1).max(120),
  })
  .strict();

const localizedDescriptionSchema = z
  .object({
    zh: z.string().trim().min(1).max(500),
    en: z.string().trim().min(1).max(500),
  })
  .strict();

const dashboardSupportHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) => {
      if (value.startsWith("/")) {
        return (
          !value.startsWith("//") && !value.includes("\\") && !/\s/.test(value)
        );
      }
      try {
        const parsed = new URL(value);
        if (parsed.protocol === "https:") return true;
        return (
          parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
        );
      } catch {
        return false;
      }
    },
    { message: "链接必须是站内绝对路径或 HTTP(S) 地址" }
  );

export const dashboardSupportServiceIconSchema = z.enum([
  "discord",
  "telegram",
  "qq",
  "wechat",
  "twitter",
  "team",
  "documentation",
  "models",
  "support",
  "website",
]);

export const dashboardSupportServiceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    enabled: z.boolean(),
    icon: dashboardSupportServiceIconSchema,
    title: localizedTextSchema,
    description: localizedDescriptionSchema,
    actionLabel: localizedTextSchema,
    url: dashboardSupportHrefSchema,
  })
  .strict();

export const dashboardSupportConfigSchema = z
  .object({
    version: z.literal(1),
    officialSupport: z
      .object({
        enabled: z.boolean(),
        channel: localizedTextSchema,
        description: localizedDescriptionSchema,
        qrCodeUrl: dashboardSupportHrefSchema.optional(),
        actionLabel: localizedTextSchema,
        actionUrl: dashboardSupportHrefSchema,
      })
      .strict(),
    services: z.array(dashboardSupportServiceSchema).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.services.forEach((service, index) => {
      if (ids.has(service.id)) {
        context.addIssue({
          code: "custom",
          message: "服务项 ID 不能重复",
          path: ["services", index, "id"],
        });
      }
      ids.add(service.id);
    });
  });

export type DashboardSupportConfig = z.infer<
  typeof dashboardSupportConfigSchema
>;
export type DashboardSupportService = z.infer<
  typeof dashboardSupportServiceSchema
>;
export type DashboardSupportServiceIcon = z.infer<
  typeof dashboardSupportServiceIconSchema
>;

export const DEFAULT_DASHBOARD_SUPPORT_CONFIG: DashboardSupportConfig = {
  version: 1,
  officialSupport: {
    enabled: true,
    channel: {
      zh: "官方支持中心",
      en: "Official support center",
    },
    description: {
      zh: "通过站内工单联系官方支持，处理账户、积分、支付与服务接入问题。",
      en: "Contact the official team for account, credits, billing, and service integration help.",
    },
    actionLabel: {
      zh: "联系支持",
      en: "Contact support",
    },
    actionUrl: "/dashboard/support/new",
  },
  services: [
    {
      id: "system-docs",
      enabled: true,
      icon: "documentation",
      title: { zh: "API 文档", en: "API docs" },
      description: {
        zh: "查看图像 API 接口和使用说明",
        en: "Explore image APIs and usage guides",
      },
      actionLabel: { zh: "查看", en: "Open" },
      url: "/dashboard/api-docs",
    },
    {
      id: "support-tickets",
      enabled: true,
      icon: "support",
      title: { zh: "支持工单", en: "Support tickets" },
      description: {
        zh: "查看问题进度并与支持团队沟通",
        en: "Track requests and communicate with the support team",
      },
      actionLabel: { zh: "进入", en: "Open" },
      url: "/dashboard/support",
    },
    {
      id: "announcements",
      enabled: true,
      icon: "website",
      title: { zh: "平台公告", en: "Announcements" },
      description: {
        zh: "了解服务更新、维护与重要通知",
        en: "Read service updates, maintenance notes, and notices",
      },
      actionLabel: { zh: "查看", en: "Open" },
      url: "/dashboard/announcements",
    },
  ],
};

/**
 * 把未知系统设置收窄为可渲染配置。
 *
 * @param value 数据库、环境变量或表单草稿中的未知值。
 * @returns 校验成功的配置；缺失或历史脏值回退到安全默认值。
 */
export function normalizeDashboardSupportConfig(
  value: unknown
): DashboardSupportConfig {
  const parsed = dashboardSupportConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_DASHBOARD_SUPPORT_CONFIG;
}
