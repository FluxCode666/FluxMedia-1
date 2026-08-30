/**
 * UOL Operations - system-settings 领域
 *
 * 职责：注册系统设置相关的所有操作定义（快照读取、更新、环境变量导入/同步、默认值初始化等）。
 * 使用方：UOL 注册表（通过 operations/index.ts 统一加载）。
 * 关键依赖：../registry.ts (defineOperation)、zod (schema 校验)。
 *
 * execute 函数接入实际 service 层实现。
 */
import { z } from "zod";
import {
  globalVideoModelCreditsPerSecondSchema,
  videoModelBillingModesSchema,
  videoModelCreditPricesSchema,
} from "../../video-generation/video-pricing";
import {
  destroyGenerationPhotosByMaxCount,
  shouldRunMaxCountCleanupOnSettingsChange,
} from "../../generation-maintenance";
import {
  createDefaultGlobalImageCreditOverrides,
  globalImageCreditOverridesSchema,
} from "../../image-backend/group-image-pricing";
import { logError } from "../../logger";
import { paginationConfigSchema } from "../../pagination/config";
import { getPaginationConfig } from "../../pagination/server";
import { bootstrapSystemSettingsEnv } from "../../system-settings/bootstrap";
import { syncSystemSettingsToEnvFiles } from "../../system-settings/env-file";
import { SystemSettingValidationError } from "../../system-settings/errors";
import {
  getAdminSystemSettingsSnapshot,
  getRuntimeSettingJson,
  getRuntimeVideoModelBillingSettings,
  getSiteBranding,
  getSystemSettingValue,
  importSystemSettingsFromEnv,
  initializeMissingSystemSettingsDefaults,
  setSiteLogoUrl,
  setSystemSettings,
} from "../../system-settings/index";
import {
  siteBrandingSchema,
  siteLogoUploadInputSchema,
  siteLogoUploadOutputSchema,
} from "../../system-settings/site-branding";
import { OperationError } from "../errors";
import { getPrincipalUserId } from "../principal";
import { defineOperation } from "../registry";

/**
 * 把设置服务的已知校验失败转换为 UOL 稳定错误，基础设施错误保持原样上抛。
 *
 * @param error - setSystemSettings 抛出的未知错误。
 * @throws OperationError 已知设置校验失败；其他错误原样抛出供网关分类。
 */
function throwSystemSettingsUpdateOperationError(error: unknown): never {
  if (error instanceof SystemSettingValidationError) {
    throw new OperationError(
      "validation_error",
      "System setting validation failed",
      {
        fieldLabel: error.fieldLabel,
        kind: error.kind,
        reason: error.reason,
      }
    );
  }
  throw error;
}

/** 管理设置快照中的可选下拉项。 */
const settingOptionSchema = z
  .object({
    label: z.string(),
    value: z.string(),
  })
  .strict();

/** 管理设置快照项；secret 的 value 始终由 service 脱敏为空字符串。 */
const adminSettingSnapshotSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    description: z.string(),
    category: z.enum([
      "general",
      "support",
      "auth",
      "payment",
      "moderation",
      "models",
      "storage",
      "mail",
      "credits",
      "analytics",
    ]),
    valueType: z.enum(["string", "number", "boolean", "select", "json"]),
    value: z.string(),
    configured: z.boolean(),
    stored: z.boolean(),
    fromEnv: z.boolean(),
    updatedAt: z.string().nullable(),
    secret: z.boolean().optional(),
    requiresRestart: z.boolean().optional(),
    requiresRebuild: z.boolean().optional(),
    options: z.array(settingOptionSchema).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    integer: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    exampleValue: z.unknown().optional(),
    managedByDedicatedOperation: z.boolean().optional(),
  })
  .strict();

/** 通用设置写入项；clear 与 value 不能同时生效。 */
const settingUpdateSchema = z
  .object({
    key: z.string().trim().min(1),
    value: z.unknown().optional(),
    clear: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.clear === true && input.value !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "清空设置时不能同时提交 value",
        path: ["value"],
      });
    }
    if (input.clear !== true && input.value === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "设置更新必须提供 value 或 clear=true",
        path: ["value"],
      });
    }
  });

/**
 * settings.getPaginationConfig - 获取全局分页大小配置
 *
 * 仅供站内页面读取动态白名单；非法或缺失设置由服务层回退默认配置。
 */
export const settingsGetPaginationConfig = defineOperation({
  name: "settings.getPaginationConfig",
  domain: "system-settings",
  title: "Get Pagination Configuration",
  description: "获取系统列表统一使用的默认分页大小和可选分页大小。",
  input: z.object({}).strict(),
  output: paginationConfigSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => getPaginationConfig(),
});

/**
 * settings.getSiteBranding - 获取公开站点品牌配置。
 *
 * 仅供站内页面和公开 Logo 路由读取，非法历史值由服务层回退内置资源。
 */
export const settingsGetSiteBranding = defineOperation({
  name: "settings.getSiteBranding",
  domain: "system-settings",
  title: "Get Site Branding",
  description: "获取当前网站 Logo 的安全公开地址，供全站品牌展示统一使用。",
  input: z.object({}).strict(),
  output: siteBrandingSchema,
  access: { kind: "system" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => getSiteBranding(),
});

/**
 * settings.setSiteLogo - 保存或恢复网站 Logo。
 *
 * 仅真实超级管理员可调用；写入使用专用 schema 与服务，不能通过通用设置入口绕过。
 */
export const settingsSetSiteLogo = defineOperation({
  name: "settings.setSiteLogo",
  domain: "system-settings",
  title: "Set Site Logo",
  description: "超级管理员保存安全 Logo 地址，或清除覆盖以恢复内置 Logo。",
  input: z
    .object({
      logoUrl: siteBrandingSchema.shape.logoUrl.nullable(),
    })
    .strict(),
  output: siteBrandingSchema,
  access: { kind: "roles", roles: ["super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["cache"],
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("网站 Logo 写入缺少可审计的管理员身份");
    }
    return setSiteLogoUrl(input.logoUrl, userId);
  },
});

/**
 * settings.uploadSiteLogo - 上传并启用网站 Logo 文件。
 *
 * Shared 只声明严格契约；图片解码、对象存储和持久幂等由 Web late binding 实现。
 */
export const settingsUploadSiteLogo = defineOperation({
  name: "settings.uploadSiteLogo",
  domain: "system-settings",
  title: "Upload Site Logo",
  description:
    "超级管理员上传 PNG、SVG 或 ICO，并启用通过安全校验的原始站点 Logo。",
  input: siteLogoUploadInputSchema,
  output: siteLogoUploadOutputSchema,
  access: { kind: "roles", roles: ["super_admin"] },
  agentExposure: "human-only",
  readOnly: false,
  destructive: true,
  idempotency: {
    kind: "required",
    keyField: "clientRequestId",
    scope: "per-user",
  },
  sideEffects: ["storage", "cache", "audit"],
  async execute(_input, _principal, _ctx) {
    throw new Error("Not yet wired: settings.uploadSiteLogo");
  },
});

/**
 * settings.getSnapshot - 获取管理后台设置快照
 *
 * 返回当前所有系统设置的完整快照，供超级管理员在管理面板查看。
 * 纯读操作，不改变系统状态。
 */
export const settingsGetSnapshot = defineOperation({
  name: "settings.getSnapshot",
  domain: "system-settings",
  title: "Get Admin Settings Snapshot",
  description:
    "获取当前所有系统设置的完整快照，供超级管理员在管理面板查看与审计。",
  input: z.object({}),
  output: z.object({
    settings: z.array(adminSettingSnapshotSchema),
    timestamp: z.string(),
  }),
  access: { kind: "superAdmin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, _principal, _ctx) => {
    const snapshot = await getAdminSystemSettingsSnapshot();
    return {
      settings: snapshot,
      timestamp: new Date().toISOString(),
    };
  },
});

/**
 * settings.update - 更新系统设置
 *
 * 超级管理员通过管理面板修改系统设置项。
 * 写操作，可能触发缓存刷新。
 */
export const settingsUpdate = defineOperation({
  name: "settings.update",
  domain: "system-settings",
  title: "Update System Settings",
  description: "超级管理员更新系统设置项（如站点名称、功能开关、限额等）。",
  input: z.object({
    updates: z.array(settingUpdateSchema).min(1),
  }),
  output: z.object({
    success: z.boolean(),
    changedKeys: z.array(z.string()),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["cache"],
  execute: async (input, principal, _ctx) => {
    const userId = getPrincipalUserId(principal) ?? "system";
    const changedKeys = await setSystemSettings(
      input.updates.map(({ key, value, clear }) => ({
        key,
        value,
        ...(clear !== undefined ? { clear } : {}),
      })),
      userId
    ).catch((error: unknown) => throwSystemSettingsUpdateOperationError(error));

    // 启用"按最大张数"清理时立即后台执行一次，与 server action 行为一致（共用谓词）。
    // WHY: fire-and-forget + catch 记日志，不阻塞 operation 返回；批量上限与幂等
    // WHERE 由清理函数自身兜底，与定时任务并发安全。
    if (
      shouldRunMaxCountCleanupOnSettingsChange(
        changedKeys,
        input.updates.find(
          ({ key }) => key === "GENERATION_IMAGE_RETENTION_MODE"
        )?.value
      )
    ) {
      void destroyGenerationPhotosByMaxCount().catch((error) => {
        logError(error, {
          source: "uol.settings-update.enable-max-count-cleanup",
        });
      });
    }

    return {
      success: true,
      changedKeys,
    };
  },
});

const globalModelPricingOutputSchema = z
  .object({
    image: globalImageCreditOverridesSchema,
    videoBillingModes: videoModelBillingModesSchema,
    videoCreditsPerItem: videoModelCreditPricesSchema,
    videoCreditsPerSecond: globalVideoModelCreditsPerSecondSchema,
  })
  .strict();

/**
 * settings.getModelPricing - 读取全局模型计费配置。
 *
 * 不从后端账号池读取任何价格；全局缺失或历史稀疏值统一回退开发默认值，确保管理端始终
 * 拿到可完整编辑的必填价格矩阵。
 */
export const settingsGetModelPricing = defineOperation({
  name: "settings.getModelPricing",
  domain: "system-settings",
  title: "读取全局模型计费配置",
  description:
    "读取图像模型四档价格及视频模型计费模式、按秒与按条分辨率价格，供管理员查看继承价格。",
  input: z.object({}),
  output: globalModelPricingOutputSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    const [imageRaw, video] = await Promise.all([
      getRuntimeSettingJson("IMAGE_MODEL_CREDIT_PRICES"),
      getRuntimeVideoModelBillingSettings(),
    ]);
    const image = globalImageCreditOverridesSchema.safeParse(imageRaw);
    return {
      image: image.success
        ? image.data
        : createDefaultGlobalImageCreditOverrides(),
      videoBillingModes: video.billingModes,
      videoCreditsPerItem: video.creditsPerItem,
      videoCreditsPerSecond: globalVideoModelCreditsPerSecondSchema.parse(
        video.creditsPerSecond
      ),
    };
  },
});

/**
 * settings.importFromEnv - 从环境变量导入设置
 *
 * 将当前进程环境变量中的设置值导入数据库，用于初始部署或迁移场景。
 * 仅超级管理员或系统身份可调用。
 */
export const settingsImportFromEnv = defineOperation({
  name: "settings.importFromEnv",
  domain: "system-settings",
  title: "Import Settings From Env",
  description:
    "从进程环境变量导入设置到数据库，用于初始部署或从 .env 迁移到 DB 存储。",
  input: z.object({
    overwriteExisting: z.boolean().optional(),
  }),
  output: z.object({
    importedCount: z.number(),
    skippedCount: z.number(),
    importedKeys: z.array(z.string()),
  }),
  access: { kind: "superAdmin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["cache"],
  hasMaintenanceWrite: true,
  execute: async (input, principal, _ctx) => {
    const userId = getPrincipalUserId(principal) ?? "system";
    const importedKeys = await importSystemSettingsFromEnv({
      updatedBy: userId,
      ...(input.overwriteExisting != null
        ? { overwrite: input.overwriteExisting }
        : {}),
    });
    return {
      importedCount: importedKeys.length,
      skippedCount: 0,
      importedKeys,
    };
  },
});

/**
 * settings.initializeDefaults - 初始化缺失的默认值
 *
 * 检查数据库中是否存在所有已定义的设置项，对缺失项写入默认值。
 * 通常在应用启动或升级后调用。仅超级管理员或系统身份。
 */
export const settingsInitializeDefaults = defineOperation({
  name: "settings.initializeDefaults",
  domain: "system-settings",
  title: "Initialize Missing Defaults",
  description:
    "检查并初始化数据库中缺失的设置项为默认值，用于应用启动或版本升级后补全配置。",
  input: z.object({}),
  output: z.object({
    initializedCount: z.number(),
    initializedKeys: z.array(z.string()),
  }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["cache"],
  hasMaintenanceWrite: true,
  execute: async (_input, principal, _ctx) => {
    const userId = getPrincipalUserId(principal) ?? "system";
    const initializedKeys = await initializeMissingSystemSettingsDefaults({
      updatedBy: userId,
    });
    return {
      initializedCount: initializedKeys.length,
      initializedKeys,
    };
  },
});

/**
 * settings.syncToEnv - 同步设置到 .env 文件
 *
 * 将数据库中的设置同步写入 .env 文件，供非 DB 感知的子进程使用。
 * 仅系统身份可调用（通常由启动脚本触发）。
 */
export const settingsSyncToEnv = defineOperation({
  name: "settings.syncToEnv",
  domain: "system-settings",
  title: "Sync Settings To Env Files",
  description:
    "将数据库中的系统设置同步写入 .env 文件，供非数据库感知的子进程读取。",
  input: z.object({
    targetPath: z.string().optional(),
  }),
  output: z.object({
    syncedCount: z.number(),
    filePath: z.string(),
  }),
  access: { kind: "system" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call"],
  processLocalState: true,
  execute: async (input, _principal, _ctx) => {
    const result = await syncSystemSettingsToEnvFiles();
    return {
      syncedCount: result.files.length,
      filePath: input.targetPath ?? result.files[0] ?? "",
    };
  },
});

/**
 * settings.bootstrap - 引导启动时的设置环境
 *
 * 应用冷启动时的一次性设置引导：从 .env 加载到内存缓存，
 * 确保后续读取无需每次访问数据库。仅系统身份（进程内部调用）。
 */
export const settingsBootstrap = defineOperation({
  name: "settings.bootstrap",
  domain: "system-settings",
  title: "Bootstrap Settings Env",
  description:
    "应用冷启动时引导设置环境：从 .env/DB 加载到进程内存缓存，确保运行时读取高效。",
  input: z.object({}),
  output: z.object({
    loadedCount: z.number(),
    source: z.enum(["database", "env", "hybrid"]),
  }),
  access: { kind: "system" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["cache"],
  processLocalState: true,
  execute: async (_input, _principal, _ctx) => {
    await bootstrapSystemSettingsEnv();
    return {
      loadedCount: 0,
      source: "hybrid" as const,
    };
  },
});

/**
 * settings.getValue - 获取单个运行时设置值
 *
 * 通用 getter，系统/内部调用以获取指定 key 的当前有效值。
 * 优先从内存缓存返回，缓存未命中则回落数据库。
 */
export const settingsGetValue = defineOperation({
  name: "settings.getValue",
  domain: "system-settings",
  title: "Get Runtime Setting Value",
  description:
    "获取指定 key 的当前运行时设置值，优先从内存缓存返回，缓存未命中回落数据库。",
  input: z.object({
    key: z.string(),
  }),
  output: z.object({
    key: z.string(),
    value: z.unknown(),
    source: z.enum(["cache", "database", "default"]),
  }),
  access: { kind: "system" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  processLocalState: true,
  execute: async (input, _principal, _ctx) => {
    // 尝试从 DB 缓存获取值，未命中则回落环境变量
    const dbValue = await getSystemSettingValue(
      input.key as Parameters<typeof getSystemSettingValue>[0]
    );
    if (dbValue !== undefined) {
      return {
        key: input.key,
        value: dbValue,
        source: "cache" as const,
      };
    }
    const envValue = process.env[input.key]?.trim() || undefined;
    if (envValue !== undefined) {
      return {
        key: input.key,
        value: envValue,
        source: "database" as const,
      };
    }
    return {
      key: input.key,
      value: undefined,
      source: "default" as const,
    };
  },
});
