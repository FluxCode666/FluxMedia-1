"use server";

/**
 * API 密钥管理 Server Actions 薄传输适配器。
 *
 * 职责：校验页面输入、构造当前 session Principal、调用六个 UOL operation，并刷新
 * API 密钥路由；数据库、分组、额度和生命周期逻辑全部由应用服务负责。
 * 使用方：external-api-key-section.tsx。
 * 关键依赖：protectedAction、UOL invoke 网关和 Web UOL 初始化。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import { ActionUserError, protectedAction } from "@repo/shared/safe-action";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type {
  ExternalApiKeyListItem,
  ExternalApiKeySummary,
} from "@/features/external-api/key-management-service";
import { ensureUolInitialized } from "@/server/uol-init";

const createKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    generationGroupId: z.string().trim().min(1).nullable().optional(),
    creditLimit: z.number().nonnegative().nullable().optional(),
  })
  .strict();

const keyIdSchema = z.object({ id: z.string().min(1) }).strict();

const updateKeyGroupSchema = z
  .object({
    id: z.string().min(1),
    generationGroupId: z.string().trim().min(1).nullable(),
  })
  .strict();

const updateKeyQuotaSchema = z
  .object({
    id: z.string().min(1),
    creditLimit: z.number().nonnegative().nullable(),
  })
  .strict();

export type ExternalApiKeyListResult = {
  keys: ExternalApiKeyListItem[];
  editableGroups: Array<{
    id: string;
    name: string;
    enabled: boolean;
    selectable: boolean;
  }>;
};

type CreateExternalApiKeyResult = {
  apiKey: string;
  key: ExternalApiKeySummary;
};

type KeyOperationOutputs = {
  "externalApi.listKeys": ExternalApiKeyListResult;
  "externalApi.createKey": CreateExternalApiKeyResult;
  "externalApi.revokeKey": ExternalApiKeySummary;
  "externalApi.deleteKey": { id: string };
  "externalApi.updateKeyGroup": ExternalApiKeySummary;
  "externalApi.updateKeyQuota": ExternalApiKeySummary;
};

type KeyOperationName = keyof KeyOperationOutputs;

/** 初始化 UOL 并从当前 session 构造唯一可信 user Principal。 */
async function createApiKeyPrincipal(userId: string): Promise<Principal> {
  await ensureUolInitialized();
  return {
    type: "user",
    userId,
    role: await getUserRoleById(userId),
  };
}

/** 调用类型绑定的 Key operation，并把预期 UOL 错误安全展示给用户。 */
async function invokeApiKeyOperation<N extends KeyOperationName>(
  name: N,
  input: unknown,
  userId: string
): Promise<KeyOperationOutputs[N]> {
  try {
    return await invokeOperation<KeyOperationOutputs[N]>(
      name,
      input,
      await createApiKeyPrincipal(userId)
    );
  } catch (error) {
    if (error instanceof OperationError) {
      throw new ActionUserError(error.message);
    }
    throw error;
  }
}

/** mutation 成功后刷新 API 密钥路由的服务端快照。 */
function revalidateApiKeyPage(): void {
  revalidatePath("/dashboard/external-api");
}

/** 读取本人 API 密钥摘要与当前可编辑分组。 */
export const getExternalApiKeys = protectedAction
  .metadata({ action: "externalApi.listKeys" })
  .action(
    async ({ ctx }): Promise<ExternalApiKeyListResult> =>
      invokeApiKeyOperation("externalApi.listKeys", {}, ctx.userId)
  );

/** 创建 API 密钥；完整明文只存在于本次 Action 成功响应。 */
export const createExternalApiKey = protectedAction
  .metadata({ action: "externalApi.createKey" })
  .schema(createKeySchema)
  .action(async ({ parsedInput, ctx }): Promise<CreateExternalApiKeyResult> => {
    const result = await invokeApiKeyOperation(
      "externalApi.createKey",
      parsedInput,
      ctx.userId
    );
    revalidateApiKeyPage();
    return result;
  });

/** 原子撤销本人当前启用的 API 密钥。 */
export const revokeExternalApiKey = protectedAction
  .metadata({ action: "externalApi.revokeKey" })
  .schema(keyIdSchema)
  .action(async ({ parsedInput, ctx }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.revokeKey",
      { keyId: parsedInput.id },
      ctx.userId
    );
    revalidateApiKeyPage();
    return result;
  });

/** 删除本人已撤销的 API 密钥。 */
export const deleteExternalApiKey = protectedAction
  .metadata({ action: "externalApi.deleteKey" })
  .schema(keyIdSchema)
  .action(async ({ parsedInput, ctx }): Promise<{ id: string }> => {
    const result = await invokeApiKeyOperation(
      "externalApi.deleteKey",
      { keyId: parsedInput.id },
      ctx.userId
    );
    revalidateApiKeyPage();
    return result;
  });

/** 更新本人启用 Key 的当前可选后端分组。 */
export const updateExternalApiKeyGroup = protectedAction
  .metadata({ action: "externalApi.updateKeyGroup" })
  .schema(updateKeyGroupSchema)
  .action(async ({ parsedInput, ctx }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.updateKeyGroup",
      {
        keyId: parsedInput.id,
        generationGroupId: parsedInput.generationGroupId,
      },
      ctx.userId
    );
    revalidateApiKeyPage();
    return result;
  });

/** 更新本人启用 Key 的积分额度。 */
export const updateExternalApiKeyQuota = protectedAction
  .metadata({ action: "externalApi.updateKeyQuota" })
  .schema(updateKeyQuotaSchema)
  .action(async ({ parsedInput, ctx }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.updateKeyQuota",
      {
        keyId: parsedInput.id,
        creditLimit: parsedInput.creditLimit,
      },
      ctx.userId
    );
    revalidateApiKeyPage();
    return result;
  });
