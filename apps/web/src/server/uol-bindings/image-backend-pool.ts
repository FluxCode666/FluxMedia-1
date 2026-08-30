/**
 * 统一媒体后端号池 UOL late binding。
 *
 * 职责：把分组、成员启停、API 上游脚本测试和进程诊断绑定到共享 operation；
 * 管理 Action 只调用 UOL，本模块是唯一可接触领域服务和生产 Worker 的适配层。
 */

import {
  type ApiUpstreamAdapterOperationId,
  apiUpstreamRequestInputSchema,
  apiUpstreamResponseInputSchema,
  apiUpstreamResponseResultForOperationSchema,
  apiUpstreamScriptContextSchema,
  parseApiUpstreamRequestEnvelope,
} from "@repo/shared/image-backend/api-upstream-script-contract";
import type { BackendGroupInput } from "@repo/shared/image-backend/group-contract";
import type { BackendMemberInput } from "@repo/shared/image-backend/member-contract";
import { logError } from "@repo/shared/logger";
import type { ModelConfigurationSnapshot } from "@repo/shared/model-marketplace";
import type { Principal } from "@repo/shared/uol";
import { bindExecute, OperationError } from "@repo/shared/uol";
import type {
  AdminPoolGroupListInput,
  AdminPoolMemberListInput,
} from "@repo/shared/uol/operations/image-backend-pool";
import {
  filterBackendGroups,
  filterBackendMembers,
} from "@/features/image-backend-pool/admin-pool-view-model";
import {
  assertApiUpstreamOpaqueValuesPreserved,
  createApiUpstreamOpaqueToken,
  restoreApiUpstreamOpaqueValues,
} from "@/features/image-backend-pool/api-upstream-opaque-values";
import { getApiUpstreamScriptPoolDiagnostics } from "@/features/image-backend-pool/api-upstream-script-pool";
import { runApiUpstreamScript } from "@/features/image-backend-pool/api-upstream-script-runtime";
import {
  BackendGroupServiceError,
  backendGroupService,
} from "@/features/image-backend-pool/group-service";
import {
  buildBackendMemberModelOptions,
  findUnavailableBackendMemberModelIds,
} from "@/features/image-backend-pool/member-model-options";
import {
  type BackendMemberAdminSummary,
  BackendMemberServiceError,
  backendMemberService,
} from "@/features/image-backend-pool/member-service";

/** 无网络脚本测试 operation 的严格输入。 */
export interface ApiUpstreamAdapterTestInput {
  operation: ApiUpstreamAdapterOperationId;
  stage: "request" | "response";
  script: string;
  sample: unknown;
}

/** 号池 binding 可替换依赖；单测注入桩，生产使用真实服务和 Worker。 */
export interface ImageBackendPoolBindingDependencies {
  groupService: Pick<
    typeof backendGroupService,
    "listGroupOptions" | "listGroups" | "saveGroup" | "deleteGroup"
  >;
  memberService: Pick<
    typeof backendMemberService,
    | "listMembers"
    | "saveMember"
    | "resetMemberStatus"
    | "setMemberEnabled"
    | "deleteMember"
  >;
  readModelConfiguration(
    principal: Principal
  ): Promise<ModelConfigurationSnapshot>;
  runScript: typeof runApiUpstreamScript;
  getRuntimeDiagnostics: typeof getApiUpstreamScriptPoolDiagnostics;
}

const defaultDependencies: ImageBackendPoolBindingDependencies = {
  groupService: backendGroupService,
  memberService: backendMemberService,
  async readModelConfiguration(principal) {
    const { productionModelConfigurationService } = await import(
      "@/features/model-configuration/service"
    );
    return productionModelConfigurationService.read(principal);
  },
  runScript: runApiUpstreamScript,
  getRuntimeDiagnostics: getApiUpstreamScriptPoolDiagnostics,
};

/** 判断未知 JSON 值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 构造通用号池成员 DTO。
 *
 * @param members 成员服务的内部管理摘要。
 * @returns 不含 refresh/余额错误正文的 UOL 输出；专用 human-only 详情另行读取。
 * @sideEffects 无；不修改输入对象。
 */
export function buildAdminPoolMembers(
  members: readonly BackendMemberAdminSummary[]
): Array<
  Omit<BackendMemberAdminSummary, "config"> & {
    config: Record<string, unknown>;
  }
> {
  return members.map((member) => {
    const config: Record<string, unknown> = { ...member.config };
    return { ...member, config };
  });
}

/** 把筛选后的内存快照收敛为统一 offset 分页信封。 */
function paginateAdminPoolRecords<Record>(
  records: readonly Record[],
  page: number,
  pageSize: number
) {
  const totalCount = records.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const normalizedPage = Math.min(page, totalPages);
  const offset = (normalizedPage - 1) * pageSize;
  return {
    records: records.slice(offset, offset + pageSize),
    page: normalizedPage,
    pageSize,
    totalCount,
    totalPages,
  };
}

/** 从管理员样例中读取模型 ID，仅用于构造脱敏脚本上下文。 */
function readSampleModelId(sample: unknown): string {
  if (!isRecord(sample)) return "sample-model";
  const body = isRecord(sample.body) ? sample.body : null;
  if (!body) return "sample-model";
  const model = body.model;
  return typeof model === "string" && model.trim()
    ? model.trim().slice(0, 240)
    : "sample-model";
}

/** 从管理员样例中读取任务 ID；原值只进入当前 Worker 作业，不进入日志。 */
function readSampleTaskId(sample: unknown): string {
  if (isRecord(sample)) {
    const candidates = [
      sample,
      ...(isRecord(sample.body) ? [sample.body] : []),
      ...(isRecord(sample.query) ? [sample.query] : []),
    ];
    for (const candidate of candidates) {
      for (const key of ["taskId", "task_id", "id"]) {
        const value = candidate[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim().slice(0, 1_024);
        }
      }
    }
  }
  return "sample-task";
}

/**
 * 把 `mock://media/*` 样例叶子替换为生产格式的不透明令牌。
 *
 * @param value 管理员提供的合成 JSON 样例。
 * @param opaqueValues 保存令牌与展示占位符的宿主映射。
 * @returns 不含真实媒体、可发送到 QuickJS Worker 的 JSON 树。
 */
function tokenizeMockMedia(
  value: unknown,
  opaqueValues: Map<string, unknown>
): unknown {
  if (typeof value === "string" && value.startsWith("mock://media/")) {
    const token = createApiUpstreamOpaqueToken();
    opaqueValues.set(token, value);
    return token;
  }
  if (Array.isArray(value)) {
    return value.map((item) => tokenizeMockMedia(item, opaqueValues));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      tokenizeMockMedia(child, opaqueValues),
    ])
  );
}

/** 将号池领域错误映射为可由任意传输稳定编码的 UOL 错误。 */
function throwBackendPoolOperationError(error: unknown): never {
  if (
    error instanceof BackendGroupServiceError ||
    error instanceof BackendMemberServiceError
  ) {
    throw new OperationError(error.code, error.message);
  }
  throw error;
}

/**
 * 校验成员能力只引用模型配置目录中的模型 ID。
 *
 * 编辑时允许原样保留迁移历史 ID；新增加的未知 ID 会在进入保存事务前失败。
 */
async function assertBackendMemberModelsComeFromConfiguration(
  input: BackendMemberInput,
  principal: Principal,
  dependencies: ImageBackendPoolBindingDependencies
): Promise<void> {
  let modelConfiguration: ModelConfigurationSnapshot;
  try {
    modelConfiguration = await dependencies.readModelConfiguration(principal);
  } catch (error) {
    logError(error, {
      source: "image-backend-pool",
      operation: "validate-member-model-options",
    });
    throw new OperationError(
      "not_ready",
      "模型配置暂不可用，无法校验成员支持的模型"
    );
  }

  const existingModelIds = input.id
    ? ((await dependencies.memberService.listMembers()).find(
        (member) => member.id === input.id
      )?.supportedModelIds ?? [])
    : [];
  const modelOptions = buildBackendMemberModelOptions(modelConfiguration);
  const unavailableModelIds = findUnavailableBackendMemberModelIds(
    input,
    modelOptions,
    existingModelIds
  );
  const optionByModelId = new Map(
    modelOptions.map((option) => [option.id.toLowerCase(), option])
  );
  const selectedModelSet = new Set(
    input.supportedModelIds.map((modelId) => modelId.toLowerCase())
  );
  const orphanResolutionModels = Object.keys(
    input.supportedResolutionsByModel ?? {}
  ).filter((modelId) => !selectedModelSet.has(modelId.toLowerCase()));
  if (orphanResolutionModels.length > 0) {
    throw new OperationError(
      "validation_error",
      `分辨率能力不能配置未选择的模型：${orphanResolutionModels
        .slice(0, 3)
        .join("、")}`
    );
  }
  const invalidResolutionModels = Object.entries(
    input.supportedResolutionsByModel ?? {}
  ).filter(([modelId, resolutions]) => {
    const supported = optionByModelId.get(
      modelId.toLowerCase()
    )?.supportedResolutions;
    return (
      !supported ||
      resolutions.some((resolution) => !supported.includes(resolution))
    );
  });
  if (invalidResolutionModels.length > 0) {
    throw new OperationError(
      "validation_error",
      `以下模型包含全局配置未声明的分辨率：${invalidResolutionModels
        .slice(0, 3)
        .map(([modelId]) => modelId)
        .join("、")}`
    );
  }
  if (input.type === "api") {
    const invalidInputCapabilityModels = Object.keys(
      input.config.videoInputCapabilitiesByModel
    ).filter(
      (modelId) =>
        optionByModelId.get(modelId.toLowerCase())?.category !== "video"
    );
    if (invalidInputCapabilityModels.length > 0) {
      throw new OperationError(
        "validation_error",
        `参考视频和音频能力只能配置到视频模型：${invalidInputCapabilityModels
          .slice(0, 3)
          .join("、")}`
      );
    }
  }
  if (unavailableModelIds.length === 0) return;

  const displayedIds = unavailableModelIds.slice(0, 3).join("、");
  const remainingCount = unavailableModelIds.length - 3;
  throw new OperationError(
    "validation_error",
    `以下模型不在当前模型配置可选范围：${displayedIds}${
      remainingCount > 0 ? ` 等 ${unavailableModelIds.length} 个` : ""
    }`
  );
}

/**
 * 执行一次无网络 API 上游脚本测试。
 *
 * 空请求脚本预览空修改信封；空响应脚本要求样例本身已是标准结果。非空脚本
 * 使用生产 Worker、共享 schema 和模拟媒体令牌，不读取成员、密钥或网络。
 */
export async function executeApiUpstreamAdapterTestBinding(
  input: ApiUpstreamAdapterTestInput,
  dependencies: Pick<
    ImageBackendPoolBindingDependencies,
    "runScript"
  > = defaultDependencies
): Promise<{ preview: unknown }> {
  try {
    const sample =
      input.stage === "request"
        ? apiUpstreamRequestInputSchema.parse(input.sample)
        : apiUpstreamResponseInputSchema.parse(input.sample);
    const opaqueValues = new Map<string, unknown>();
    const tokenizedSample = Object.hasOwn(sample, "body")
      ? {
          ...sample,
          body: tokenizeMockMedia(sample.body, opaqueValues),
        }
      : sample;
    assertApiUpstreamOpaqueValuesPreserved(tokenizedSample, opaqueValues);
    const modelId = readSampleModelId(sample);
    const context = apiUpstreamScriptContextSchema.parse({
      operation: input.operation,
      stage: input.stage,
      contentType:
        input.operation === "images.edit"
          ? "multipart/form-data"
          : "application/json",
      platformModelId: modelId,
      upstreamModelId: modelId,
      ...(input.operation.includes("query")
        ? { taskId: readSampleTaskId(sample) }
        : {}),
    });
    const rawOutput = input.script.trim()
      ? await dependencies.runScript(tokenizedSample, input.script, context, {
          operation: input.operation,
          stage: input.stage,
          priority: "admin",
        })
      : input.stage === "request"
        ? {}
        : tokenizedSample;
    const parsed =
      input.stage === "request"
        ? parseApiUpstreamRequestEnvelope(input.operation, rawOutput)
        : apiUpstreamResponseResultForOperationSchema(input.operation).parse(
            rawOutput
          );
    if (input.stage === "request") {
      const requestSample =
        apiUpstreamRequestInputSchema.parse(tokenizedSample);
      assertApiUpstreamOpaqueValuesPreserved(
        {
          query: "query" in parsed ? parsed.query : requestSample.query,
          headers: "headers" in parsed ? parsed.headers : {},
          ...(requestSample.body !== undefined ||
          ("body" in parsed && parsed.body !== undefined)
            ? {
                body:
                  "body" in parsed && parsed.body !== undefined
                    ? parsed.body
                    : requestSample.body,
              }
            : {}),
        },
        opaqueValues
      );
    } else {
      assertApiUpstreamOpaqueValuesPreserved(parsed, opaqueValues);
    }
    return {
      preview: restoreApiUpstreamOpaqueValues(parsed, opaqueValues),
    };
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError(
      "validation_error",
      "供应商请求处理脚本测试失败，请检查脚本和样例"
    );
  }
}

/** 读取当前进程的脱敏 Worker 快照并映射到共享 UOL 输出。 */
export function executeApiUpstreamRuntimeDiagnosticsBinding(
  dependencies: Pick<
    ImageBackendPoolBindingDependencies,
    "getRuntimeDiagnostics"
  > = defaultDependencies
) {
  const diagnostics = dependencies.getRuntimeDiagnostics();
  return {
    lifecycle: diagnostics.state,
    workerCount: diagnostics.configuredWorkers,
    liveWorkerCount: diagnostics.readyWorkers,
    requestQueueLength: diagnostics.queuedRequests,
    responseQueueLength: diagnostics.queuedResponses,
    responsePermitsInUse: diagnostics.activeResponsePermits,
    responsePermitCapacity: diagnostics.responsePermitCapacity,
    saturationCount: diagnostics.saturationCount,
    replacementCount: diagnostics.replacementCount,
  } as const;
}

/** 获取用户可选择的启用分组。 */
bindExecute("pool.getGroupOptions", async () => ({
  options: await defaultDependencies.groupService.listGroupOptions(),
}));

/** 读取统一分组和成员的脱敏管理快照。 */
bindExecute("pool.getAdminPool", async () => {
  const [groups, members] = await Promise.all([
    defaultDependencies.groupService.listGroups(),
    defaultDependencies.memberService.listMembers(),
  ]);
  return { groups, members: buildAdminPoolMembers(members) };
});

/** 按人工页面筛选分页成员。 */
bindExecute(
  "pool.listAdminMembers",
  async (input: AdminPoolMemberListInput, principal) => {
    const [members, modelConfigurationResult] =
      await Promise.all([
        defaultDependencies.memberService.listMembers(),
        defaultDependencies
          .readModelConfiguration(principal)
          .then((configuration) => ({
            status: "ready" as const,
            configuration,
          }))
          .catch(() => ({ status: "unavailable" as const })),
      ]);
    const pageMembers = members.map((member) => ({
      ...member,
      credentialHealthStatus: null,
    }));
    const modelResolutionsById =
      modelConfigurationResult.status === "ready"
        ? new Map(
            modelConfigurationResult.configuration.entries.map((entry) => [
              entry.configKey.trim().toLowerCase(),
              entry.supportedResolutions ?? [],
            ])
          )
        : null;
    const filterableMembers = pageMembers.map((member) => {
      if (!modelResolutionsById) return member;
      const memberOverrides = member.supportedResolutionsByModel ?? {};
      const effectiveResolutionsByModel = Object.fromEntries(
        member.supportedModelIds.map((modelId) => {
          const modelKey = modelId.trim().toLowerCase();
          const override = Object.entries(memberOverrides).find(
            ([candidate]) => candidate.trim().toLowerCase() === modelKey
          )?.[1];
          return [
            modelKey,
            override ?? modelResolutionsById.get(modelKey) ?? [],
          ];
        })
      );
      return {
        ...member,
        supportedResolutionsByModel: effectiveResolutionsByModel,
      };
    });
    const filteredIds = new Set(
      filterBackendMembers(
        filterableMembers,
        {
          name: input.name,
          credentialStatus: input.credentialStatus,
          modelId: input.modelId,
          resolution: input.resolution,
          createdFrom: input.createdFrom,
          createdTo: input.createdTo,
        },
        input.timeZone
      ).map((member) => member.id)
    );
    return paginateAdminPoolRecords(
      pageMembers.filter((member) => filteredIds.has(member.id)),
      input.page,
      input.pageSize
    );
  }
);

/** 按人工页面名称条件分页分组。 */
bindExecute("pool.listAdminGroups", async (input: AdminPoolGroupListInput) => {
  const groups = await defaultDependencies.groupService.listGroups();
  return paginateAdminPoolRecords(
    filterBackendGroups(groups, input.name),
    input.page,
    input.pageSize
  );
});

/** 保存统一分组。 */
bindExecute("pool.saveGroup", async (input: BackendGroupInput) => {
  try {
    return await defaultDependencies.groupService.saveGroup(input);
  } catch (error) {
    throwBackendPoolOperationError(error);
  }
});

/** 删除不再被使用的非默认分组。 */
bindExecute("pool.deleteGroup", async (input: { id: string }) => {
  try {
    return await defaultDependencies.groupService.deleteGroup(input.id);
  } catch (error) {
    throwBackendPoolOperationError(error);
  }
});

/** 保存 API 成员及其适配配置。 */
bindExecute(
  "pool.saveMember",
  async (input: BackendMemberInput, principal: Principal) => {
    try {
      await assertBackendMemberModelsComeFromConfiguration(
        input,
        principal,
        defaultDependencies
      );
      return await defaultDependencies.memberService.saveMember(input);
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** 使用生产 Worker 执行无网络适配脚本测试。 */
bindExecute(
  "pool.testApiUpstreamAdapter",
  async (input: ApiUpstreamAdapterTestInput) =>
    executeApiUpstreamAdapterTestBinding(input)
);

/** 返回当前 Web 进程的 Worker Pool 诊断。 */
bindExecute("pool.getApiUpstreamRuntimeDiagnostics", async () =>
  executeApiUpstreamRuntimeDiagnosticsBinding()
);

/** 清除成员暂态运行故障并恢复新租约资格。 */
bindExecute("pool.resetMemberStatus", async (input: { id: string }) => {
  try {
    return await defaultDependencies.memberService.resetMemberStatus(input.id);
  } catch (error) {
    throwBackendPoolOperationError(error);
  }
});

/** 原子修改成员启用状态，并保留当前租约及运行指标。 */
bindExecute(
  "pool.setMemberEnabled",
  async (input: { id: string; isEnabled: boolean }) => {
    try {
      return await defaultDependencies.memberService.setMemberEnabled(
        input.id,
        input.isEnabled
      );
    } catch (error) {
      throwBackendPoolOperationError(error);
    }
  }
);

/** 按统一成员 ID 执行运行中任务保护删除。 */
bindExecute("pool.deleteMember", async (input: { id: string }) => {
  try {
    return await defaultDependencies.memberService.deleteMember(input.id);
  } catch (error) {
    throwBackendPoolOperationError(error);
  }
});
