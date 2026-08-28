"use server";

/**
 * 统一媒体后端号池 Server Actions。
 *
 * 职责：校验浏览器输入、构造当前 session Principal、调用 pool.* UOL operation
 * 并刷新管理页面。数据库、凭据和分组不变量全部由 operation
 * binding 后的领域服务负责。
 */
import { getUserRoleById } from "@repo/shared/auth/role-server";
import {
  apiUpstreamAdapterOperationIdSchema,
  apiUpstreamJsonValueSchema,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import {
  type BackendGroupInput,
  type BackendGroupSummary,
  backendGroupInputSchema,
} from "@repo/shared/image-backend/group-contract";
import {
  type BackendMemberInput,
  backendMemberInputSchema,
} from "@repo/shared/image-backend/member-contract";
import { logError } from "@repo/shared/logger";
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
import {
  type AdminPoolGroupListInput,
  type AdminPoolGroupListOutput,
  type AdminPoolMemberListInput,
  type AdminPoolMemberListOutput,
  adminPoolGroupListInputSchema,
  adminPoolMemberListInputSchema,
} from "@repo/shared/uol/operations/image-backend-pool";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ensureUolInitialized } from "@/server/uol-init";
import type { AdobeCredentialHealthStatus } from "./adobe-credential-health-status";
import type { BackendMemberAdminSummary } from "./member-service";
import { backendMemberExportDocumentSchema } from "./member-transfer";

/** 页面成员摘要；凭据健康来自独立 human-only 批量 operation。 */
export type BackendPoolAdminMemberSummary = BackendMemberAdminSummary & {
  credentialHealthStatus: AdobeCredentialHealthStatus | null;
};

/** 统一号池页面快照；不含任何明文凭据或凭据诊断。 */
export interface BackendPoolAdminSnapshot {
  groups: BackendGroupSummary[];
  members: BackendPoolAdminMemberSummary[];
}

/** 页面成员列表分页结果；保留分页前既有的折叠诊断卡片字段。 */
export interface BackendPoolAdminMemberListOutput
  extends Omit<AdminPoolMemberListOutput, "records"> {
  records: BackendPoolAdminMemberSummary[];
}

/** 通用 pool.getAdminPool 保持可投影给 Agent 的无凭据健康快照。 */
interface BackendPoolBaseAdminSnapshot {
  groups: BackendGroupSummary[];
  members: BackendMemberAdminSummary[];
}

/** 页面批量凭据健康 operation 的最小输出。 */
interface AdobeCredentialHealthStatusListOutput {
  statuses: Array<{
    memberId: string;
    status: AdobeCredentialHealthStatus;
  }>;
}

/** 管理员专用 Adobe 凭据健康摘要；诊断只含严格 allowlist 字段。 */
export interface AdobeCredentialHealthSummary {
  memberId: string;
  status: "pending" | "healthy" | "degraded" | "isolated" | "overdue";
  consecutiveFailures: number;
  failureProfiles: Array<"express" | "firefly">;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  evaluationDeadlineAt: string | null;
  isolatedAt: string | null;
  diagnostic: {
    statusCode?: number;
    adobeErrorCode?: string;
    message?: string;
    requestId?: string;
  } | null;
}

/** 管理员检查与重新授权共享的安全结果。 */
export interface AdobeCredentialEvaluationResult {
  evaluationId: string;
  disposition: "accepted" | "stale" | "discarded";
  health: AdobeCredentialHealthSummary;
}

/** pool operation 与浏览器动作所需输出的类型映射。 */
type PoolOperationOutputs = {
  "pool.getGroupOptions": {
    options: Array<{ id: string; name: string }>;
  };
  "pool.getAdminPool": BackendPoolBaseAdminSnapshot;
  "pool.listAdminMembers": AdminPoolMemberListOutput;
  "pool.listAdminGroups": AdminPoolGroupListOutput;
  "pool.listAdobeCredentialHealthStatuses": AdobeCredentialHealthStatusListOutput;
  "pool.saveGroup": { id: string };
  "pool.deleteGroup": { success: boolean };
  "pool.saveMember": { id: string };
  "pool.resetMemberStatus": { success: boolean };
  "pool.setMemberEnabled": { id: string; isEnabled: boolean };
  "pool.deleteMember": { success: boolean };
  "pool.checkAdobeCredentialHealth": AdobeCredentialEvaluationResult;
  "pool.getAdobeCredentialHealth": AdobeCredentialHealthSummary;
  "pool.reauthorizeAdobeCredential": AdobeCredentialEvaluationResult;
  "pool.testApiUpstreamAdapter": { preview: unknown };
  "pool.getApiUpstreamRuntimeDiagnostics": {
    lifecycle: "starting" | "ready" | "unavailable" | "draining" | "closed";
    workerCount: number;
    liveWorkerCount: number;
    requestQueueLength: number;
    responseQueueLength: number;
    responsePermitsInUse: number;
    responsePermitCapacity: number;
    saturationCount: number;
    replacementCount: number;
  };
};

type PoolOperationName = keyof PoolOperationOutputs;

const idSchema = z.object({ id: z.string().trim().min(1).max(128) }).strict();

const setMemberEnabledSchema = idSchema
  .extend({ isEnabled: z.boolean() })
  .strict();

const adobeCredentialMemberSchema = z
  .object({ memberId: z.string().trim().min(1).max(128) })
  .strict();

const adobeCredentialReauthorizationSchema = adobeCredentialMemberSchema
  .extend({
    cookie: z.string().trim().min(1).max(64_000),
    clientRequestId: z.string().trim().min(1).max(128),
  })
  .strict();

const apiUpstreamAdapterTestInputSchema = z
  .object({
    operation: apiUpstreamAdapterOperationIdSchema,
    stage: z.enum(["request", "response"]),
    script: z.string().max(32_768),
    sample: apiUpstreamJsonValueSchema,
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

/**
 * mutation 成功后刷新供应商与分组管理入口的服务端快照。
 *
 * 两个页面共享成员、分组和计费覆盖数据；同时失效可避免一个页面保留另一个页面
 * 刚修改后的陈旧归属或计数。
 */
function revalidateBackendPoolPage(): void {
  revalidatePath("/dashboard/admin/suppliers");
  revalidatePath("/dashboard/admin/supplier-groups");
}

/**
 * 将通用账号池快照与 human-only 凭据健康状态合并为页面视图。
 *
 * @param pool 不含凭据健康的通用账号池快照。
 * @param health 仅含成员 ID 与当前状态的批量健康输出。
 * @returns 每个成员恰好带一个可筛选状态；非 Adobe Direct 为 null。
 * @sideEffects 无。
 * @failure 不抛错；缺失的状态项按不适用处理。
 */
function buildBackendPoolAdminSnapshot(
  pool: BackendPoolBaseAdminSnapshot,
  health: AdobeCredentialHealthStatusListOutput
): BackendPoolAdminSnapshot {
  const statusByMemberId = new Map(
    health.statuses.map((item) => [item.memberId, item.status])
  );
  return {
    groups: pool.groups,
    members: pool.members.map((member) => ({
      ...member,
      credentialHealthStatus: statusByMemberId.get(member.id) ?? null,
    })),
  };
}

/** 恢复 UOL 分别校验后的成员 type/config 判别关联。 */
function restoreMemberDiscriminant(
  member: AdminPoolMemberListOutput["records"][number]
): BackendPoolAdminMemberSummary {
  if (member.type === "api" && !("mode" in member.config)) {
    // WHY：UOL schema 分别校验 type 与 config；此处经互斥字段检查恢复二者的判别关联。
    const config = member.config as Extract<
      BackendMemberAdminSummary,
      { type: "api" }
    >["config"];
    return { ...member, type: "api", config };
  }
  if (member.type !== "adobe" || !("mode" in member.config)) {
    throw new Error("账号池成员类型与配置不匹配");
  }
  if (member.config.mode === "gateway") {
    const config = member.config as Extract<
      BackendMemberAdminSummary,
      { type: "adobe" }
    >["config"];
    return { ...member, type: "adobe", config };
  }
  const config = member.config as Extract<
    BackendMemberAdminSummary,
    { type: "adobe" }
  >["config"];
  return {
    ...member,
    type: "adobe",
    config,
  };
}

/** 读取通用号池快照，并并行合入不向 Agent 暴露的凭据健康状态。 */
export const getAdminImageBackendPoolAction = imageBackendPoolViewerAction
  .metadata({ action: "imageBackendPool.list" })
  .action(async ({ ctx }): Promise<BackendPoolAdminSnapshot> => {
    const principal = {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    } as const satisfies Principal;
    const [pool, health] = await Promise.all([
      invokePoolOperation("pool.getAdminPool", {}, principal),
      invokePoolOperation(
        "pool.listAdobeCredentialHealthStatuses",
        {},
        principal
      ),
    ]);
    return buildBackendPoolAdminSnapshot(pool, health);
  });

/** 按 URL 条件分页读取人工账号池成员明细。 */
export const listAdminImageBackendMembersAction = imageBackendPoolViewerAction
  .metadata({ action: "imageBackendPool.listMembers" })
  .schema(adminPoolMemberListInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<BackendPoolAdminMemberListOutput> => {
      const result = await invokePoolOperation(
        "pool.listAdminMembers",
        parsedInput satisfies AdminPoolMemberListInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      );
      return {
        ...result,
        records: result.records.map(restoreMemberDiscriminant),
      };
    }
  );

/** 按 URL 条件分页读取人工账号池分组明细。 */
export const listAdminImageBackendGroupsAction = imageBackendPoolViewerAction
  .metadata({ action: "imageBackendPool.listGroups" })
  .schema(adminPoolGroupListInputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<AdminPoolGroupListOutput> =>
      invokePoolOperation(
        "pool.listAdminGroups",
        parsedInput satisfies AdminPoolGroupListInput,
        { type: "user", userId: ctx.userId, role: ctx.role }
      )
  );

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

/**
 * 逐条导入供应商账号配置。
 *
 * 导出文件默认不含凭据；更新原账号时服务端会保留已有凭据，新账号则必须在导入
 * JSON 中补入对应的 API Key 或 Cookie。每条独立报告结果，避免一个坏账号吞掉整批
 * 导入结果；所有条目仍通过 pool.saveMember 的服务端权限、模型和数据库不变量校验。
 */
export const importImageBackendMembersAction = adminAction
  .metadata({ action: "imageBackendPool.importMembers" })
  .schema(backendMemberExportDocumentSchema)
  .action(async ({ parsedInput, ctx }) => {
    const principal = {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    } as const satisfies Principal;
    const imported: Array<{ index: number; id: string; name: string }> = [];
    const failed: Array<{
      index: number;
      name: string;
      message: string;
    }> = [];

    for (const [index, rawMember] of parsedInput.members.entries()) {
      const memberResult = backendMemberInputSchema.safeParse(rawMember);
      const rawName =
        typeof rawMember === "object" &&
        rawMember !== null &&
        "name" in rawMember &&
        typeof rawMember.name === "string"
          ? rawMember.name
          : `第 ${index + 1} 个账号`;
      if (!memberResult.success) {
        failed.push({
          index,
          name: rawName,
          message: memberResult.error.issues[0]?.message ?? "账号配置无效",
        });
        continue;
      }

      try {
        const result = await invokePoolOperation(
          "pool.saveMember",
          memberResult.data,
          principal
        );
        imported.push({ index, id: result.id, name: memberResult.data.name });
      } catch (error) {
        if (!(error instanceof ActionUserError)) {
          logError(error, {
            source: "image-backend-pool-import",
            memberIndex: index,
          });
        }
        failed.push({
          index,
          name: memberResult.data.name,
          message:
            error instanceof ActionUserError
              ? error.message
              : "账号保存失败，请检查配置后重试",
        });
      }
    }

    if (imported.length > 0) {
      revalidateBackendPoolPage();
    }
    return { imported, failed };
  });

/** 清除统一成员的暂态运行失败状态，不改凭据、指标或租约。 */
export const resetImageBackendMemberStatusAction = adminAction
  .metadata({ action: "imageBackendPool.resetMemberStatus" })
  .schema(idSchema)
  .action(async ({ parsedInput, ctx }) => {
    await invokePoolOperation("pool.resetMemberStatus", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    });
    revalidateBackendPoolPage();
    return { success: true };
  });

/** 修改统一成员启用状态；停用只阻止新任务获租，不中断进行中的任务。 */
export const setImageBackendMemberEnabledAction = adminAction
  .metadata({ action: "imageBackendPool.setMemberEnabled" })
  .schema(setMemberEnabledSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.setMemberEnabled",
      parsedInput,
      {
        type: "user",
        userId: ctx.userId,
        role: ctx.role,
      }
    );
    revalidateBackendPoolPage();
    return { success: true, ...result };
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

/** 管理员读取 Adobe direct 成员的安全健康摘要。 */
export const getAdobeCredentialHealthAction = adminAction
  .metadata({ action: "imageBackendPool.getAdobeCredentialHealth" })
  .schema(adobeCredentialMemberSchema)
  .action(async ({ parsedInput, ctx }) =>
    invokePoolOperation("pool.getAdobeCredentialHealth", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    })
  );

/** 管理员立即执行一次双 Profile 凭据检查。 */
export const checkAdobeCredentialHealthAction = adminAction
  .metadata({ action: "imageBackendPool.checkAdobeCredentialHealth" })
  .schema(adobeCredentialMemberSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.checkAdobeCredentialHealth",
      parsedInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return result;
  });

/** 管理员为同一 Adobe 账号提交新 Cookie 并恢复隔离状态。 */
export const reauthorizeAdobeCredentialAction = adminAction
  .metadata({ action: "imageBackendPool.reauthorizeAdobeCredential" })
  .schema(adobeCredentialReauthorizationSchema)
  .action(async ({ parsedInput, ctx }) => {
    const result = await invokePoolOperation(
      "pool.reauthorizeAdobeCredential",
      parsedInput,
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
    revalidateBackendPoolPage();
    return result;
  });

/** 使用生产 Worker 和合成样例执行无网络 API 上游脚本测试。 */
export const testApiUpstreamAdapterAction = adminAction
  .metadata({ action: "imageBackendPool.testApiUpstreamAdapter" })
  .schema(apiUpstreamAdapterTestInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    return invokePoolOperation("pool.testApiUpstreamAdapter", parsedInput, {
      type: "user",
      userId: ctx.userId,
      role: ctx.role,
    });
  });

/** 读取当前 Web 进程的脱敏 API 上游脚本运行诊断。 */
export const getApiUpstreamRuntimeDiagnosticsAction = adminAction
  .metadata({ action: "imageBackendPool.getApiUpstreamRuntimeDiagnostics" })
  .action(async ({ ctx }) => {
    return invokePoolOperation(
      "pool.getApiUpstreamRuntimeDiagnostics",
      {},
      { type: "user", userId: ctx.userId, role: ctx.role }
    );
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
