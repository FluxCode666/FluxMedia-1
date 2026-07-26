"use server";

import { getUserRoleById } from "@repo/shared/auth/role-server";
/**
 * 统一媒体后端号池 Server Actions。
 *
 * 职责：校验浏览器输入、构造当前 session Principal、调用 pool.* UOL operation
 * 并刷新管理页面。数据库、凭据和分组不变量全部由 operation
 * binding 后的领域服务负责。
 */
import {
  type BackendGroupInput,
  type BackendGroupSummary,
  backendGroupInputSchema,
} from "@repo/shared/image-backend/group-contract";
import {
  type BackendMemberInput,
  backendMemberInputSchema,
} from "@repo/shared/image-backend/member-contract";
import {
  type RequestParameterMapping,
  requestParameterMappingsSchema,
} from "@repo/shared/image-backend/request-parameter-mapping";
import {
  ActionUserError,
  adminAction,
  imageBackendPoolViewerAction,
  protectedAction,
} from "@repo/shared/safe-action";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ensureUolInitialized } from "@/server/uol-init";
import type { BackendMemberAdminSummary } from "./member-service";

/** 统一号池管理快照；不含任何明文凭据。 */
export interface BackendPoolAdminSnapshot {
  groups: BackendGroupSummary[];
  members: BackendMemberAdminSummary[];
}

/** API Images 参数映射模板。 */
export interface BackendParameterMappingTemplate {
  id: string;
  name: string;
  parameterMappings: RequestParameterMapping[];
}

/** pool operation 与浏览器动作所需输出的类型映射。 */
type PoolOperationOutputs = {
  "pool.getGroupOptions": {
    options: Array<{ id: string; name: string }>;
  };
  "pool.getAdminPool": BackendPoolAdminSnapshot;
  "pool.saveGroup": { id: string };
  "pool.deleteGroup": { success: boolean };
  "pool.saveMember": { id: string };
  "pool.deleteMember": { success: boolean };
  "pool.listParameterMappingTemplates": {
    templates: BackendParameterMappingTemplate[];
  };
  "pool.saveParameterMappingTemplate": { id: string };
  "pool.deleteParameterMappingTemplate": { success: boolean };
};

type PoolOperationName = keyof PoolOperationOutputs;

const idSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();

const parameterMappingTemplateInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128).optional(),
    name: z.string().trim().min(1).max(80),
    parameterMappings: requestParameterMappingsSchema,
  })
  .strict();

/** 初始化 UOL 并调用类型绑定的号池 operation。 */
async function invokePoolOperation<N extends PoolOperationName>(
  name: N,
  input: unknown,
  principal: Principal
): Promise<PoolOperationOutputs[N]> {
  await ensureUolInitialized();
  try {
    return await invokeOperation<PoolOperationOutputs[N]>(
      name,
      input,
      principal
    );
  } catch (error) {
    if (error instanceof OperationError) {
      throw new ActionUserError(error.message);
    }
    throw error;
  }
}

/** mutation 成功后刷新管理后台的服务端快照。 */
function revalidateBackendPoolPage(): void {
  revalidatePath("/dashboard/admin/settings");
}

/** 读取统一分组与成员的脱敏管理快照。 */
export const getAdminImageBackendPoolAction = imageBackendPoolViewerAction
  .metadata({ action: "imageBackendPool.list" })
  .action(async ({ ctx }): Promise<BackendPoolAdminSnapshot> => {
    return invokePoolOperation(
      "pool.getAdminPool",
      {},
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
  });

/** 保存统一媒体后端分组。 */
export const saveImageBackendGroupAction = adminAction
  .metadata({ action: "imageBackendPool.saveGroup" })
  .schema(backendGroupInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.saveGroup",
      parsedInput satisfies BackendGroupInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return { success: true, id: result.id };
  });

/** 删除不再使用的非默认分组。 */
export const deleteImageBackendGroupAction = adminAction
  .metadata({ action: "imageBackendPool.deleteGroup" })
  .schema(idSchema)
  .action(async ({ parsedInput, ctx }) => {
    await invokePoolOperation("pool.deleteGroup", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    });
    revalidateBackendPoolPage();
    return { success: true };
  });

/** 以 `api | adobe` 单一入口保存媒体后端成员。 */
export const saveImageBackendMemberAction = adminAction
  .metadata({ action: "imageBackendPool.saveMember" })
  .schema(backendMemberInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.saveMember",
      parsedInput satisfies BackendMemberInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return { success: true, id: result.id };
  });

/** 按统一成员 ID 删除没有租约或未完成视频任务的成员。 */
export const deleteImageBackendMemberAction = adminAction
  .metadata({ action: "imageBackendPool.deleteMember" })
  .schema(idSchema)
  .action(async ({ parsedInput, ctx }) => {
    await invokePoolOperation("pool.deleteMember", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    });
    revalidateBackendPoolPage();
    return { success: true };
  });

/** 获取用户可选择的启用分组。 */
export const getImageBackendGroupOptionsAction = protectedAction
  .metadata({ action: "imageBackendPool.groupOptions" })
  .action(async ({ ctx }) => {
    return invokePoolOperation(
      "pool.getGroupOptions",
      {},
      {
        type: "user",
        userId: ctx.userId,
        role: await getUserRoleById(ctx.userId),
      }
    );
  });

/** 读取 API Images 参数映射模板。 */
export const getImageBackendParameterMappingTemplatesAction =
  imageBackendPoolViewerAction
    .metadata({ action: "imageBackendPool.listParameterMappingTemplates" })
    .action(async ({ ctx }) => {
      return invokePoolOperation(
        "pool.listParameterMappingTemplates",
        {},
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
    });

/** 保存 API Images 参数映射模板。 */
export const saveImageBackendParameterMappingTemplateAction = adminAction
  .metadata({ action: "imageBackendPool.saveParameterMappingTemplate" })
  .schema(parameterMappingTemplateInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.saveParameterMappingTemplate",
      parsedInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return { success: true, id: result.id };
  });

/** 删除 API Images 参数映射模板。 */
export const deleteImageBackendParameterMappingTemplateAction = adminAction
  .metadata({ action: "imageBackendPool.deleteParameterMappingTemplate" })
  .schema(idSchema)
  .action(async ({ parsedInput, ctx }) => {
    await invokePoolOperation(
      "pool.deleteParameterMappingTemplate",
      parsedInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return { success: true };
  });
