"use server";

/**
 * API 密钥管理 Server Actions 薄传输适配器。
 *
 * 职责：校验页面输入、构造当前 session Principal、调用六个 UOL operation，并刷新
 * API 密钥路由；数据库、分组、额度和生命周期逻辑全部由应用服务负责。
 * 使用方：external-api-key-section.tsx。
 * 关键依赖：protectedAction、UOL invoke 网关和 Web UOL 初始化。
 */
import { protectedAction } from "@repo/shared/safe-action";
import { z } from "zod";
import { requestGoJson } from "@/server/go-backend-client";

import type { ExternalApiKeyListItem, ExternalApiKeySummary } from "@/features/external-api/key-management-service";

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

const listKeySchema = z.object({}).strict();

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

type KeyOperationInputs = {
  "externalApi.listKeys": z.output<typeof listKeySchema>;
  "externalApi.createKey": z.output<typeof createKeySchema>;
  "externalApi.revokeKey": { keyId: string };
  "externalApi.deleteKey": { keyId: string };
  "externalApi.updateKeyGroup": {
    keyId: string;
    generationGroupId: string | null;
  };
  "externalApi.updateKeyQuota": {
    keyId: string;
    creditLimit: number | null;
  };
};

async function invokeApiKeyOperation<N extends KeyOperationName>(
  name: N,
  input: KeyOperationInputs[N]
): Promise<KeyOperationOutputs[N]> {
  const keyId = "keyId" in input ? encodeURIComponent(input.keyId) : "";
  const paths: Record<KeyOperationName, string> = {
    "externalApi.listKeys": "/api/external-api/keys",
    "externalApi.createKey": "/api/external-api/keys",
    "externalApi.revokeKey": `/api/external-api/keys/${keyId}`,
    "externalApi.deleteKey": `/api/external-api/keys/${keyId}?hard=1`,
    "externalApi.updateKeyGroup": `/api/external-api/keys/${keyId}`,
    "externalApi.updateKeyQuota": `/api/external-api/keys/${keyId}`,
  };
  const method = name.endsWith("listKeys")
    ? "GET"
    : name.endsWith("createKey")
      ? "POST"
      : name.endsWith("deleteKey") || name.endsWith("revokeKey")
        ? "DELETE"
        : "PATCH";
  return requestGoJson<KeyOperationOutputs[N]>(paths[name], {
    method,
    ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
  });
}

/** 读取本人 API 密钥摘要与当前可编辑分组。 */
export const getExternalApiKeys = protectedAction
  .metadata({ action: "externalApi.listKeys" })
  .schema(listKeySchema)
  .action(
    async ({ parsedInput }): Promise<ExternalApiKeyListResult> =>
      invokeApiKeyOperation("externalApi.listKeys", parsedInput)
  );

/** 创建 API 密钥；完整明文只存在于本次 Action 成功响应。 */
export const createExternalApiKey = protectedAction
  .metadata({ action: "externalApi.createKey" })
  .schema(createKeySchema)
  .action(async ({ parsedInput }): Promise<CreateExternalApiKeyResult> => {
    return invokeApiKeyOperation("externalApi.createKey", parsedInput);
  });

/** 原子撤销本人当前启用的 API 密钥。 */
export const revokeExternalApiKey = protectedAction
  .metadata({ action: "externalApi.revokeKey" })
  .schema(keyIdSchema)
  .action(async ({ parsedInput }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.revokeKey",
      { keyId: parsedInput.id }
    );
    return result;
  });

/** 删除本人已撤销的 API 密钥。 */
export const deleteExternalApiKey = protectedAction
  .metadata({ action: "externalApi.deleteKey" })
  .schema(keyIdSchema)
  .action(async ({ parsedInput }): Promise<{ id: string }> => {
    const result = await invokeApiKeyOperation(
      "externalApi.deleteKey",
      { keyId: parsedInput.id }
    );
    return result;
  });

/** 更新本人启用 Key 的当前可选后端分组。 */
export const updateExternalApiKeyGroup = protectedAction
  .metadata({ action: "externalApi.updateKeyGroup" })
  .schema(updateKeyGroupSchema)
  .action(async ({ parsedInput }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.updateKeyGroup",
      { keyId: parsedInput.id, generationGroupId: parsedInput.generationGroupId }
    );
    return result;
  });

/** 更新本人启用 Key 的积分额度。 */
export const updateExternalApiKeyQuota = protectedAction
  .metadata({ action: "externalApi.updateKeyQuota" })
  .schema(updateKeyQuotaSchema)
  .action(async ({ parsedInput }): Promise<ExternalApiKeySummary> => {
    const result = await invokeApiKeyOperation(
      "externalApi.updateKeyQuota",
      { keyId: parsedInput.id, creditLimit: parsedInput.creditLimit }
    );
    return result;
  });
