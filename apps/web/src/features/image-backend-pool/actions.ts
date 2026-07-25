"use server";

import { videoModelCreditsPerSecondMapSchema } from "@repo/shared/adobe";
import { adobeEnabledModelIdsSchema } from "@repo/shared/adobe/enabled-models";
import {
  isSubscriptionPlan,
  type SubscriptionPlan,
} from "@repo/shared/config/subscription-plan";
import { imageCreditOverridesSchema } from "@repo/shared/image-backend/group-image-pricing";
import { requestParameterMappingsSchema } from "@repo/shared/image-backend/request-parameter-mapping";
import { supportedModelIdsSchema } from "@repo/shared/image-backend/supported-models";

import {
  adminAction,
  imageBackendPoolViewerAction,
  protectedAction,
} from "@repo/shared/safe-action";
import {
  getRuntimeSettingBoolean,
  getRuntimeSettingNumber,
  getRuntimeSettingString,
  setSystemSettings,
} from "@repo/shared/system-settings";
import { invokeOperation } from "@repo/shared/uol";
import { z } from "zod";

import {
  deleteAdobeAccount,
  importAdobeAccount,
  importAdobeAccountsBatch,
  listAdobeAccounts,
  setAdobeAccountEnabled,
} from "@/features/image-generation/adobe-direct";
import { ensureUolInitialized } from "@/server/uol-init";
import {
  bulkUpdateImageBackendAccounts,
  countAvailableWebAccountsInGroup,
  deleteImageBackendGroup,
  deleteImageBackendMembers,
  deleteSub2ApiAutoSyncTask,
  importImageBackendAccountsFromRefreshTokens,
  importImageBackendWebAccountsFromAccessTokens,
  isSub2ApiPostgresConfigured,
  listAdminImageBackendPool,
  listImageBackendGroupOptions,
  listSub2ApiAutoSyncTasksForAdmin,
  listSub2ApiSourceGroups,
  probeImageBackendApi,
  readSub2ApiSyncProgress,
  refreshImageBackendAccountInfo,
  refreshImageBackendAccountsInfo,
  runSub2ApiAutoSyncTaskNow,
  runSub2ApiManualSync,
  setImageBackendAccountAlwaysActive,
  setImageBackendAdobeAlwaysActive,
  setImageBackendAdobeEnabled,
  setImageBackendApiAlwaysActive,
  setImageBackendApiEnabled,
  setSub2ApiAutoSyncTaskEnabled,
  setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState,
  syncImageBackendAccountsFromSub2Api,
  updateSub2ApiAutoSyncTaskOptions,
  upsertImageBackendAccount,
} from "./service";

const nullableGroupIdSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value !== "default" ? value : null));

const optionalGroupIdSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value && value !== "default"
        ? value
        : null
  );

const safetyOverrideSchema = z.enum(["inherit", "enabled", "disabled"]);
const accountBackendSchema = z.enum(["web", "responses"]);
const groupBackendTypeSchema = z.enum(["mixed", "web", "responses"]);
const apiInterfaceModeSchema = z.enum(["images", "responses", "mixed"]);
const chatCompletionsUpstreamModeSchema = z.enum([
  "responses",
  "chat_completions",
]);
const imagesUpstreamModeSchema = z.enum(["images", "responses"]);
const sub2ApiTokenSyncModeSchema = z.enum(["web", "responses", "both"]);
const sub2ApiPlanFilterSchema = z.enum([
  "all",
  "free",
  "plus",
  "pro",
  "non_free",
]);
const subscriptionPlanSchema = z
  .string()
  .trim()
  .optional()
  .transform(
    (value): SubscriptionPlan => (isSubscriptionPlan(value) ? value : "free")
  );

const withImageBackendPoolAdminAction = (name: string) =>
  adminAction.metadata({ action: `imageBackendPool.${name}` });

const withImageBackendPoolViewerAction = (name: string) =>
  imageBackendPoolViewerAction.metadata({ action: `imageBackendPool.${name}` });

export const getAdminImageBackendPoolAction = withImageBackendPoolViewerAction(
  "list"
).action(async () => {
  const pool = await listAdminImageBackendPool();
  return pool;
});

export const getSub2ApiSyncStatusAction = withImageBackendPoolAdminAction(
  "sub2ApiSyncStatus"
).action(async () => {
  return {
    configured: await isSub2ApiPostgresConfigured(),
  };
});

// 全量同步进行中由前端轮询读取进度(进程内单槽,best-effort)。
export const getSub2ApiSyncProgressAction = withImageBackendPoolAdminAction(
  "sub2ApiSyncProgress"
).action(async () => {
  const progress = readSub2ApiSyncProgress();
  return { progress: progress ? { ...progress } : null };
});

export const getSub2ApiSourceGroupsAction = withImageBackendPoolAdminAction(
  "sub2ApiSourceGroups"
).action(async () => {
  const groups = await listSub2ApiSourceGroups();
  return { groups };
});

export const getSub2ApiAutoSyncTasksAction = withImageBackendPoolAdminAction(
  "sub2ApiAutoSyncTasks"
).action(async () => {
  const tasks = await listSub2ApiAutoSyncTasksForAdmin();
  return { tasks };
});

export const runSub2ApiAutoSyncTaskNowAction = withImageBackendPoolAdminAction(
  "runSub2ApiAutoSyncTaskNow"
)
  .schema(
    z.object({
      taskId: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    return runSub2ApiAutoSyncTaskNow(parsedInput.taskId);
  });

export const setSub2ApiAutoSyncTaskEnabledAction =
  withImageBackendPoolAdminAction("setSub2ApiAutoSyncTaskEnabled")
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        enabled: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setSub2ApiAutoSyncTaskEnabled(parsedInput);
      return { success: true };
    });

export const setSub2ApiAutoSyncTaskOverwriteLocalUnavailableStateAction =
  withImageBackendPoolAdminAction(
    "setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState"
  )
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        overwriteLocalUnavailableState: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setSub2ApiAutoSyncTaskOverwriteLocalUnavailableState(parsedInput);
      return { success: true };
    });

export const updateSub2ApiAutoSyncTaskOptionsAction =
  withImageBackendPoolAdminAction("updateSub2ApiAutoSyncTaskOptions")
    .schema(
      z.object({
        taskId: z.string().trim().min(1),
        enabled: z.boolean(),
        webGroupId: optionalGroupIdSchema,
        responsesGroupId: optionalGroupIdSchema,
        syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
        allowMobileRtImport: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        overwriteLocalUnavailableState: z.boolean().default(true),
        planFilter: sub2ApiPlanFilterSchema.default("non_free"),
        intervalMinutes: z.coerce.number().int().min(1).default(720),
      })
    )
    .action(async ({ parsedInput }) => {
      await updateSub2ApiAutoSyncTaskOptions(parsedInput);
      return { success: true };
    });

export const deleteSub2ApiAutoSyncTaskAction = withImageBackendPoolAdminAction(
  "deleteSub2ApiAutoSyncTask"
)
  .schema(
    z.object({
      taskId: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    await deleteSub2ApiAutoSyncTask(parsedInput.taskId);
    return { success: true };
  });

export const saveImageBackendGroupAction = withImageBackendPoolAdminAction(
  "saveGroup"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(500).optional(),
      isEnabled: z.boolean().default(true),
      isDefault: z.boolean().default(false),
      isUserSelectable: z.boolean().default(true),
      contentSafety: safetyOverrideSchema.default("inherit"),
      backendType: groupBackendTypeSchema.default("mixed"),
      minPlan: subscriptionPlanSchema,
      imageCreditOverrides: imageCreditOverridesSchema.default({
        version: 1,
        byModel: {},
      }),
      videoCreditOverrides: videoModelCreditsPerSecondMapSchema.default({}),
      childGroupIds: z.array(z.string().trim().min(1)).max(100).default([]),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const result = await invokeOperation<{ id: string }>(
      "pool.saveGroup",
      {
        ...parsedInput,
        description: parsedInput.description || undefined,
      },
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    return { success: true, id: result.id };
  });

export const deleteImageBackendGroupAction = withImageBackendPoolAdminAction(
  "deleteGroup"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    await deleteImageBackendGroup(parsedInput.id);
    return { success: true };
  });

export const saveImageBackendAccountAction = withImageBackendPoolAdminAction(
  "saveAccount"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      groupId: nullableGroupIdSchema,
      groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().max(200).optional(),
      accessToken: z.string().trim().optional(),
      refreshToken: z.string().trim().optional(),
      implementationMode: accountBackendSchema.default("web"),
      model: z.string().trim().max(120).optional(),
      contentSafetyEnabled: z.boolean().default(true),
      isEnabled: z.boolean().default(true),
      alwaysActive: z.boolean().default(false),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
      concurrency: z.coerce.number().int().min(1).max(100).default(1),
      status: z.string().trim().max(80).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const id = await upsertImageBackendAccount({
      id: parsedInput.id,
      groupId: parsedInput.groupId,
      groupIds: parsedInput.groupIds,
      name: parsedInput.name,
      email: parsedInput.email || null,
      accessToken: parsedInput.accessToken || undefined,
      refreshToken: parsedInput.refreshToken || undefined,
      implementationMode: parsedInput.implementationMode,
      model: parsedInput.model || null,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      isEnabled: parsedInput.isEnabled,
      alwaysActive: parsedInput.alwaysActive,
      priority: parsedInput.priority,
      concurrency: parsedInput.concurrency,
      status: parsedInput.status || "active",
    });
    return { success: true, id };
  });

export const bulkUpdateImageBackendAccountsAction =
  withImageBackendPoolAdminAction("bulkUpdateAccounts")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
        groupId: optionalGroupIdSchema,
        implementationMode: accountBackendSchema.optional(),
        contentSafetyEnabled: z.boolean().optional(),
        isEnabled: z.boolean().optional(),
        status: z.string().trim().max(80).optional(),
        resetAvailability: z.boolean().optional(),
        priority: z.coerce.number().int().min(0).max(10000).optional(),
        concurrency: z.coerce.number().int().min(1).max(100).optional(),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await bulkUpdateImageBackendAccounts({
        accountIds: parsedInput.accountIds,
        groupId: parsedInput.groupId,
        implementationMode: parsedInput.implementationMode || null,
        contentSafetyEnabled:
          parsedInput.contentSafetyEnabled === undefined
            ? null
            : parsedInput.contentSafetyEnabled,
        isEnabled:
          parsedInput.isEnabled === undefined ? null : parsedInput.isEnabled,
        status: parsedInput.status === undefined ? null : parsedInput.status,
        resetAvailability:
          parsedInput.resetAvailability === undefined
            ? null
            : parsedInput.resetAvailability,
        priority:
          parsedInput.priority === undefined ? null : parsedInput.priority,
        concurrency:
          parsedInput.concurrency === undefined
            ? null
            : parsedInput.concurrency,
      });
      return { success: true, ...result };
    });

export const bulkDeleteImageBackendAccountsAction =
  withImageBackendPoolAdminAction("bulkDeleteAccounts")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await deleteImageBackendMembers({
        accountIds: parsedInput.accountIds,
      });
      return {
        success: true,
        deletedCount: result.deletedAccountCount,
      };
    });

export const importImageBackendAccountsFromRefreshTokensAction =
  withImageBackendPoolAdminAction("importAccountsFromRefreshTokens")
    .schema(
      z.object({
        refreshTokensText: z.string().trim().min(1),
        webGroupId: nullableGroupIdSchema,
        responsesGroupId: nullableGroupIdSchema,
        syncMode: sub2ApiTokenSyncModeSchema.default("both"),
        useMobileRt: z.boolean().default(false),
        namePrefix: z.string().trim().max(80).optional(),
        model: z.string().trim().max(120).optional(),
        contentSafetyEnabled: z.boolean().default(true),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(100).default(1),
        importBatchId: z.string().trim().min(1).max(128).optional(),
        startIndex: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await importImageBackendAccountsFromRefreshTokens({
        refreshTokensText: parsedInput.refreshTokensText,
        webGroupId: parsedInput.webGroupId,
        responsesGroupId: parsedInput.responsesGroupId,
        syncMode: parsedInput.syncMode,
        useMobileRt: parsedInput.useMobileRt,
        namePrefix: parsedInput.namePrefix || null,
        model: parsedInput.model || null,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        priority: parsedInput.priority,
        concurrency: parsedInput.concurrency,
        importBatchId: parsedInput.importBatchId,
        startIndex: parsedInput.startIndex,
      });
      return { success: true, ...result };
    });

export const importImageBackendWebAccountsFromAccessTokensAction =
  withImageBackendPoolAdminAction("importWebAccountsFromAccessTokens")
    .schema(
      z.object({
        accessTokensText: z.string().trim().min(1),
        webGroupId: nullableGroupIdSchema,
        namePrefix: z.string().trim().max(80).optional(),
        model: z.string().trim().max(120).optional(),
        contentSafetyEnabled: z.boolean().default(true),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(100).default(1),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await importImageBackendWebAccountsFromAccessTokens({
        accessTokensText: parsedInput.accessTokensText,
        webGroupId: parsedInput.webGroupId,
        namePrefix: parsedInput.namePrefix || null,
        model: parsedInput.model || null,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        priority: parsedInput.priority,
        concurrency: parsedInput.concurrency,
      });
      return { success: true, ...result };
    });

export const syncImageBackendAccountsFromSub2ApiAction =
  withImageBackendPoolAdminAction("syncSub2ApiAccounts")
    .schema(
      z.object({
        webGroupId: nullableGroupIdSchema,
        responsesGroupId: nullableGroupIdSchema,
        sourceGroupId: nullableGroupIdSchema,
        sourceGroupName: z.string().trim().max(120).optional(),
        syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
        allowMobileRtImport: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        planFilter: sub2ApiPlanFilterSchema.default("non_free"),
        createSyncTask: z.boolean().default(false),
        overwriteLocalUnavailableState: z.boolean().default(true),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await syncImageBackendAccountsFromSub2Api({
        webGroupId: parsedInput.webGroupId,
        responsesGroupId: parsedInput.responsesGroupId,
        sourceGroupId: parsedInput.sourceGroupId,
        sourceGroupName: parsedInput.sourceGroupName || null,
        syncMode: parsedInput.allowMobileRtImport
          ? parsedInput.syncMode
          : "responses",
        allowMobileRtImport: parsedInput.allowMobileRtImport,
        contentSafetyEnabled: parsedInput.contentSafetyEnabled,
        limit: parsedInput.limit,
        offset: parsedInput.offset,
        planFilter: parsedInput.planFilter,
        createSyncTask: parsedInput.createSyncTask,
        cleanupManagedAccounts: parsedInput.createSyncTask,
        overwriteLocalUnavailableState:
          parsedInput.overwriteLocalUnavailableState,
      });
      return { success: true, ...result };
    });

export const runSub2ApiManualSyncAction = withImageBackendPoolAdminAction(
  "runSub2ApiManualSync"
)
  .schema(
    z.object({
      webGroupId: nullableGroupIdSchema,
      responsesGroupId: nullableGroupIdSchema,
      sourceGroupId: nullableGroupIdSchema,
      sourceGroupName: z.string().trim().max(120).optional(),
      syncMode: sub2ApiTokenSyncModeSchema.default("responses"),
      allowMobileRtImport: z.boolean().default(false),
      contentSafetyEnabled: z.boolean().default(true),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      planFilter: sub2ApiPlanFilterSchema.default("non_free"),
      createSyncTask: z.boolean().default(true),
      overwriteLocalUnavailableState: z.boolean().default(true),
      intervalMinutes: z.coerce.number().int().min(1).default(720),
    })
  )
  .action(async ({ parsedInput }) => {
    const result = await runSub2ApiManualSync({
      webGroupId: parsedInput.webGroupId,
      responsesGroupId: parsedInput.responsesGroupId,
      sourceGroupId: parsedInput.sourceGroupId,
      sourceGroupName: parsedInput.sourceGroupName || null,
      syncMode: parsedInput.allowMobileRtImport
        ? parsedInput.syncMode
        : "responses",
      allowMobileRtImport: parsedInput.allowMobileRtImport,
      contentSafetyEnabled: parsedInput.contentSafetyEnabled,
      limit: parsedInput.limit,
      planFilter: parsedInput.planFilter,
      createSyncTask: parsedInput.createSyncTask,
      overwriteLocalUnavailableState:
        parsedInput.overwriteLocalUnavailableState,
      intervalMinutes: parsedInput.intervalMinutes,
    });
    return result;
  });

export const saveImageBackendApiAction = withImageBackendPoolAdminAction(
  "saveApi"
)
  .schema(
    z.object({
      id: z.string().trim().optional(),
      groupId: nullableGroupIdSchema,
      groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
      name: z.string().trim().min(1).max(120),
      baseUrl: z.string().trim().url(),
      apiKey: z.string().trim().optional(),
      model: z.string().trim().max(120).optional(),
      supportedModelIds: supportedModelIdsSchema.default([]),
      interfaceMode: apiInterfaceModeSchema.default("mixed"),
      chatCompletionsUpstreamMode:
        chatCompletionsUpstreamModeSchema.default("responses"),
      imagesUpstreamMode: imagesUpstreamModeSchema.default("images"),
      parameterMappings: requestParameterMappingsSchema.default([]),
      useStream: z.boolean().default(false),
      contentSafetyEnabled: z.boolean().default(true),
      isEnabled: z.boolean().default(true),
      alwaysActive: z.boolean().default(false),
      failureCooldownEnabled: z.boolean().default(false),
      priority: z.coerce.number().int().min(0).max(10000).default(50),
      concurrency: z.coerce.number().int().min(1).max(10000).default(10),
      // Adobe 来源：上游实为 Adobe 的 gpt 格式 api，开启后进 firefly 候选。
      adobeSourced: z.boolean().default(false),
      status: z.string().trim().max(80).optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const result = await invokeOperation<{ id: string }>(
      "pool.saveApi",
      {
        ...parsedInput,
        apiKey: parsedInput.apiKey || undefined,
        model: parsedInput.model || undefined,
        status: parsedInput.status || "active",
      },
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    return { success: true, id: result.id };
  });

export const getImageBackendParameterMappingTemplatesAction =
  withImageBackendPoolViewerAction("listParameterMappingTemplates").action(
    async ({ ctx }) => {
      await ensureUolInitialized();
      return await invokeOperation<{
        templates: Array<{
          id: string;
          name: string;
          parameterMappings: z.infer<typeof requestParameterMappingsSchema>;
        }>;
      }>(
        "pool.listParameterMappingTemplates",
        {},
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    }
  );

export const saveImageBackendParameterMappingTemplateAction =
  withImageBackendPoolAdminAction("saveParameterMappingTemplate")
    .schema(
      z.object({
        id: z.string().trim().optional(),
        name: z.string().trim().min(1).max(80),
        parameterMappings: requestParameterMappingsSchema,
      })
    )
    .action(async ({ parsedInput, ctx }) => {
      await ensureUolInitialized();
      const result = await invokeOperation<{ id: string }>(
        "pool.saveParameterMappingTemplate",
        parsedInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
      return { success: true, id: result.id };
    });

export const deleteImageBackendParameterMappingTemplateAction =
  withImageBackendPoolAdminAction("deleteParameterMappingTemplate")
    .schema(z.object({ id: z.string().trim().min(1) }))
    .action(async ({ parsedInput, ctx }) => {
      await ensureUolInitialized();
      await invokeOperation<{ success: boolean }>(
        "pool.deleteParameterMappingTemplate",
        parsedInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
      return { success: true };
    });

export const saveImageBackendAdobeAction = withImageBackendPoolAdminAction(
  "saveAdobe"
)
  .schema(
    z
      .object({
        id: z.string().trim().optional(),
        groupId: nullableGroupIdSchema,
        groupIds: z.array(z.string().trim().min(1)).max(100).optional(),
        name: z.string().trim().min(1).max(120),
        mode: z.enum(["gateway", "direct"]).default("gateway"),
        baseUrl: z.string().trim().default(""),
        apiKey: z.string().trim().optional(),
        enabledModels: adobeEnabledModelIdsSchema.optional(),
        defaultRatio: z.string().trim().max(20).default("1x1"),
        defaultResolution: z.string().trim().max(10).default("2k"),
        gptImageQuality: z.enum(["low", "medium", "high"]).default("high"),
        supportsVideo: z.boolean().default(false),
        contentSafetyEnabled: z.boolean().default(true),
        isEnabled: z.boolean().default(true),
        alwaysActive: z.boolean().default(false),
        failureCooldownEnabled: z.boolean().default(false),
        priority: z.coerce.number().int().min(0).max(10000).default(50),
        concurrency: z.coerce.number().int().min(1).max(10000).default(10),
        status: z.string().trim().max(80).optional(),
      })
      // gateway 模式必须有合法 baseUrl；direct 模式凭据走 Adobe 账号（另表），baseUrl 可空。
      .refine(
        (value) =>
          value.mode === "direct" || /^https?:\/\//i.test(value.baseUrl),
        { message: "baseUrl must be a valid URL", path: ["baseUrl"] }
      )
  )
  .action(async ({ parsedInput, ctx }) => {
    await ensureUolInitialized();
    const result = await invokeOperation<{ id: string }>(
      "pool.saveAdobe",
      {
        ...parsedInput,
        apiKey: parsedInput.apiKey || undefined,
        status: parsedInput.status || "active",
      },
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    return { success: true, id: result.id };
  });

export const setImageBackendAdobeEnabledAction =
  withImageBackendPoolAdminAction("setAdobeEnabled")
    .schema(z.object({ id: z.string().trim().min(1), isEnabled: z.boolean() }))
    .action(async ({ parsedInput }) => {
      await setImageBackendAdobeEnabled(parsedInput);
      return { success: true };
    });

export const setImageBackendAdobeAlwaysActiveAction =
  withImageBackendPoolAdminAction("setAdobeAlwaysActive")
    .schema(
      z.object({ id: z.string().trim().min(1), alwaysActive: z.boolean() })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendAdobeAlwaysActive(parsedInput);
      return { success: true };
    });

// ===== Adobe 直连账号管理（mode=direct）=====

export const listAdobeAccountsAction = withImageBackendPoolAdminAction(
  "listAdobeAccounts"
)
  .schema(z.object({ memberId: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    const accounts = await listAdobeAccounts(parsedInput.memberId);
    return { success: true, accounts };
  });

export const importAdobeAccountAction = withImageBackendPoolAdminAction(
  "importAdobeAccount"
)
  .schema(
    z.object({
      memberId: z.string().trim().min(1),
      name: z.string().trim().max(120).optional(),
      cookie: z.string().trim().min(1),
      scope: z.string().trim().max(2000).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const account = await importAdobeAccount({
      memberId: parsedInput.memberId,
      name: parsedInput.name,
      cookie: parsedInput.cookie,
      scope: parsedInput.scope ?? null,
    });
    return { success: true, account };
  });

export const importAdobeAccountsAction = withImageBackendPoolAdminAction(
  "importAdobeAccounts"
)
  .schema(
    z.object({
      memberId: z.string().trim().min(1),
      cookiesText: z.string().trim().min(1),
      namePrefix: z.string().trim().max(120).optional(),
      scope: z.string().trim().max(2000).optional(),
    })
  )
  .action(async ({ parsedInput }) => {
    const result = await importAdobeAccountsBatch({
      memberId: parsedInput.memberId,
      cookiesText: parsedInput.cookiesText,
      namePrefix: parsedInput.namePrefix,
      scope: parsedInput.scope ?? null,
    });
    return { success: true, result };
  });

export const deleteAdobeAccountAction = withImageBackendPoolAdminAction(
  "deleteAdobeAccount"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    await deleteAdobeAccount(parsedInput.id);
    return { success: true };
  });

export const setAdobeAccountEnabledAction = withImageBackendPoolAdminAction(
  "setAdobeAccountEnabled"
)
  .schema(z.object({ id: z.string().trim().min(1), isEnabled: z.boolean() }))
  .action(async ({ parsedInput }) => {
    await setAdobeAccountEnabled(parsedInput.id, parsedInput.isEnabled);
    return { success: true };
  });

export const setImageBackendApiEnabledAction = withImageBackendPoolAdminAction(
  "setApiEnabled"
)
  .schema(
    z.object({
      id: z.string().trim().min(1),
      isEnabled: z.boolean(),
    })
  )
  .action(async ({ parsedInput }) => {
    await setImageBackendApiEnabled(parsedInput);
    return { success: true };
  });

export const setImageBackendApiAlwaysActiveAction =
  withImageBackendPoolAdminAction("setApiAlwaysActive")
    .schema(
      z.object({
        id: z.string().trim().min(1),
        alwaysActive: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendApiAlwaysActive(parsedInput);
      return { success: true };
    });

export const setImageBackendAccountAlwaysActiveAction =
  withImageBackendPoolAdminAction("setAccountAlwaysActive")
    .schema(
      z.object({
        id: z.string().trim().min(1),
        alwaysActive: z.boolean(),
      })
    )
    .action(async ({ parsedInput }) => {
      await setImageBackendAccountAlwaysActive(parsedInput);
      return { success: true };
    });

export const testImageBackendApiAction = withImageBackendPoolAdminAction(
  "testApi"
)
  .schema(z.object({ id: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    const probe = await probeImageBackendApi(parsedInput.id);
    return { success: true, ...probe };
  });

export const deleteImageBackendMemberAction = withImageBackendPoolAdminAction(
  "deleteMember"
)
  .schema(
    z.object({
      type: z.enum(["account", "api", "adobe"]),
      id: z.string().trim().min(1),
    })
  )
  .action(async ({ parsedInput }) => {
    await deleteImageBackendMembers(
      parsedInput.type === "account"
        ? { accountIds: [parsedInput.id] }
        : parsedInput.type === "adobe"
          ? { adobeIds: [parsedInput.id] }
          : { apiIds: [parsedInput.id] }
    );
    return { success: true };
  });

export const refreshImageBackendAccountInfoAction =
  withImageBackendPoolAdminAction("refreshAccountInfo")
    .schema(z.object({ id: z.string().trim().min(1) }))
    .action(async ({ parsedInput }) => {
      const info = await refreshImageBackendAccountInfo(parsedInput.id);
      return { success: true, info };
    });

export const refreshImageBackendAccountsInfoAction =
  withImageBackendPoolAdminAction("refreshAccountsInfo")
    .schema(
      z.object({
        accountIds: z.array(z.string().trim().min(1)).min(1).max(10000),
      })
    )
    .action(async ({ parsedInput }) => {
      const result = await refreshImageBackendAccountsInfo(
        parsedInput.accountIds
      );
      return { success: true, ...result };
    });

export const getImageBackendGroupOptionsAction = protectedAction
  .metadata({ action: "imageBackendPool.groupOptions" })
  .action(async () => {
    const groups = await listImageBackendGroupOptions();
    return { groups };
  });

// 读取 ChatGPT 注册机配置（moemail + 代理 + IP 刷新 + 号池维持）
export const getChatgptRegisterConfigAction = withImageBackendPoolAdminAction(
  "getChatgptRegisterConfig"
).action(async () => {
  const [
    apiKey,
    baseUrl,
    domain,
    domains,
    domainRotationEnabled,
    proxy,
    proxyDisabled,
    refreshUrl,
    refreshMinIntervalSeconds,
    refreshMinAttempts,
    maintainEnabled,
    maintainGroupId,
    maintainTarget,
    maintainMaxPerRun,
    maintainConcurrency,
  ] = await Promise.all([
    getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_API_KEY"),
    getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_BASE_URL"),
    getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_DOMAIN"),
    getRuntimeSettingString("CHATGPT_REGISTER_DOMAINS"),
    getRuntimeSettingBoolean("CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED", false),
    getRuntimeSettingString("CHATGPT_REGISTER_PROXY"),
    getRuntimeSettingBoolean("CHATGPT_REGISTER_PROXY_DISABLED", false),
    getRuntimeSettingString("CHATGPT_REGISTER_REFRESH_URL"),
    getRuntimeSettingNumber(
      "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
      60
    ),
    getRuntimeSettingNumber("CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS", 100),
    getRuntimeSettingBoolean("CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED", false),
    getRuntimeSettingString("CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID"),
    getRuntimeSettingNumber("CHATGPT_REGISTER_POOL_MAINTAIN_TARGET", 0),
    getRuntimeSettingNumber("CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN", 10),
    getRuntimeSettingNumber("CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY", 5),
  ]);
  return {
    apiKey,
    baseUrl,
    domain,
    domains,
    domainRotationEnabled,
    proxy,
    proxyDisabled,
    refreshUrl,
    refreshMinIntervalSeconds,
    refreshMinAttempts,
    maintainEnabled,
    maintainGroupId,
    maintainTarget,
    maintainMaxPerRun,
    maintainConcurrency,
  };
});

// 查询某分组当前可用 web 账号数（号池维持面板展示用）
export const getGroupAvailableCountAction = withImageBackendPoolAdminAction(
  "getGroupAvailableCount"
)
  .schema(z.object({ groupId: z.string().trim().min(1) }))
  .action(async ({ parsedInput }) => {
    const available = await countAvailableWebAccountsInGroup(
      parsedInput.groupId
    );
    return { available };
  });

// 从 Moemail 服务端查询可用邮箱域名列表
export const getMoemailDomainsAction = withImageBackendPoolAdminAction(
  "getMoemailDomains"
)
  .schema(
    z.object({
      baseUrl: z.string().trim().min(1).optional(),
      apiKey: z.string().trim().min(1).optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const baseUrl =
      parsedInput.baseUrl?.replace(/\/$/, "") ??
      (await getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_BASE_URL")) ??
      "https://mail.52ai.org";
    const apiKey =
      parsedInput.apiKey ??
      (await getRuntimeSettingString("CHATGPT_REGISTER_MOEMAIL_API_KEY"));
    if (!apiKey) {
      throw new Error("未配置 Moemail API Key");
    }
    // Moemail 用 X-API-Key 头鉴权（非 Authorization: Bearer），/api/config 返回
    // emailDomains 为逗号分隔字符串（非 domains 数组）。
    const resp = await fetch(`${baseUrl}/api/config`, {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`Moemail 返回 ${resp.status}`);
    }
    const data = (await resp.json()) as {
      emailDomains?: string;
    };
    const domains = (data.emailDomains ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    // 自动保存可用域名列表，供「轮换域名」使用（用户手动查询即落库）。
    if (domains.length > 0) {
      await setSystemSettings(
        [{ key: "CHATGPT_REGISTER_DOMAINS", value: domains.join(",") }],
        ctx.userId
      );
    }
    return { domains };
  });

// 保存 ChatGPT 注册机配置（moemail + 代理 + IP 刷新 + 号池维持）
export const saveChatgptRegisterConfigAction = withImageBackendPoolAdminAction(
  "saveChatgptRegisterConfig"
)
  .schema(
    z.object({
      apiKey: z.string().trim().optional(),
      baseUrl: z.string().trim().optional(),
      domain: z.string().trim().optional(),
      domainRotationEnabled: z.boolean().optional(),
      proxy: z.string().trim().optional(),
      proxyDisabled: z.boolean().optional(),
      refreshUrl: z.string().trim().optional(),
      refreshMinIntervalSeconds: z.coerce.number().int().min(1).optional(),
      refreshMinAttempts: z.coerce.number().int().min(1).optional(),
      maintainEnabled: z.boolean().optional(),
      maintainGroupId: z.string().trim().optional(),
      maintainTarget: z.coerce.number().int().min(0).optional(),
      maintainMaxPerRun: z.coerce.number().int().min(1).optional(),
      maintainConcurrency: z.coerce.number().int().min(1).optional(),
    })
  )
  .action(async ({ parsedInput, ctx }) => {
    const entries: Array<{ key: string; value: unknown }> = [];
    const put = (key: string, value: unknown) => {
      if (value !== undefined) entries.push({ key, value });
    };
    put("CHATGPT_REGISTER_MOEMAIL_API_KEY", parsedInput.apiKey);
    put("CHATGPT_REGISTER_MOEMAIL_BASE_URL", parsedInput.baseUrl);
    put("CHATGPT_REGISTER_MOEMAIL_DOMAIN", parsedInput.domain);
    put(
      "CHATGPT_REGISTER_DOMAIN_ROTATION_ENABLED",
      parsedInput.domainRotationEnabled
    );
    put("CHATGPT_REGISTER_PROXY", parsedInput.proxy);
    put("CHATGPT_REGISTER_PROXY_DISABLED", parsedInput.proxyDisabled);
    put("CHATGPT_REGISTER_REFRESH_URL", parsedInput.refreshUrl);
    put(
      "CHATGPT_REGISTER_REFRESH_MIN_INTERVAL_SECONDS",
      parsedInput.refreshMinIntervalSeconds
    );
    put(
      "CHATGPT_REGISTER_REFRESH_MIN_ATTEMPTS",
      parsedInput.refreshMinAttempts
    );
    put("CHATGPT_REGISTER_POOL_MAINTAIN_ENABLED", parsedInput.maintainEnabled);
    put("CHATGPT_REGISTER_POOL_MAINTAIN_GROUP_ID", parsedInput.maintainGroupId);
    put("CHATGPT_REGISTER_POOL_MAINTAIN_TARGET", parsedInput.maintainTarget);
    put(
      "CHATGPT_REGISTER_POOL_MAINTAIN_MAX_PER_RUN",
      parsedInput.maintainMaxPerRun
    );
    put(
      "CHATGPT_REGISTER_POOL_MAINTAIN_CONCURRENCY",
      parsedInput.maintainConcurrency
    );
    if (entries.length > 0) {
      await setSystemSettings(entries, ctx.userId);
    }
    return { success: true };
  });
