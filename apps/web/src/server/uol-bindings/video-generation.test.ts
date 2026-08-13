/**
 * 视频 UOL late binding 的 DB-free 契约测试。
 *
 * 职责：验证能力发现只使用 Principal 可信分组、只暴露公共能力与配置可达性，
 * 并将损坏的动态覆盖统一收敛为可定位的 not_ready 错误。
 * 使用方：apps/web Vitest 门禁；所有设置和数据库读取均通过依赖注入替换。
 */

import type { OperationError, Principal } from "@repo/shared/uol";
import { describe, expect, it, vi } from "vitest";

import {
  executeVideoListCapabilitiesBinding,
  type VideoCapabilityBindingDependencies,
} from "./video-generation-capabilities";

const userPrincipal = {
  type: "user",
  userId: "user-1",
  role: "user",
} satisfies Principal;

const apiKeyPrincipal = {
  type: "apiKey",
  credentialKind: "external",
  userId: "user-1",
  apiKeyId: "key-1",
} satisfies Principal;

/** 构造可观测的视频能力 binding 依赖桩。 */
function dependencies(input?: {
  overrides?: unknown;
  configuredModelIds?: string[];
}): {
  value: VideoCapabilityBindingDependencies;
  loadOverrides: ReturnType<typeof vi.fn>;
  listConfiguredModelIds: ReturnType<typeof vi.fn>;
} {
  const loadOverrides = vi.fn(async () => input?.overrides);
  const listConfiguredModelIds = vi.fn(
    async () => input?.configuredModelIds ?? ["seedance2"]
  );
  return {
    value: {
      loadCapabilityOverrides: loadOverrides,
      listConfiguredModelIds,
      reportFailure: vi.fn(),
    },
    loadOverrides,
    listConfiguredModelIds,
  };
}

/** 从能力项中移除唯一允许随分组变化的可达性字段。 */
function omitReachability<T extends { configuredReachable: boolean }>(
  item: T
): Omit<T, "configuredReachable"> {
  const { configuredReachable: _discarded, ...capability } = item;
  return capability;
}

describe("executeVideoListCapabilitiesBinding", () => {
  it("Seedance 默认返回 10 张参考图，管理员覆盖后返回 20 张", async () => {
    const defaults = dependencies();
    const defaultOutput = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      defaults.value
    );
    expect(
      defaultOutput.items.find((item) => item.model === "seedance2")?.input
        .referenceImages.maxCount
    ).toBe(10);
    expect(defaultOutput.items.map((item) => item.model)).toEqual([
      "sora2",
      "sora2-pro",
      "veo31",
      "veo31-fast",
      "veo31-ref",
      "kling-o3",
      "kling3",
      "kling3-omni",
      "runway-gen45",
      "ray314",
      "ray314-hdr",
      "seedance2",
      "seedance2-fast",
    ]);

    const overridden = dependencies({
      overrides: {
        version: 1,
        byModel: { seedance2: { maxReferenceImages: 20 } },
      },
    });
    const overriddenOutput = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      overridden.value
    );
    expect(
      overriddenOutput.items.find((item) => item.model === "seedance2")?.input
        .referenceImages.maxCount
    ).toBe(20);
  });

  it("API Key 不能覆盖绑定分组，并只按 Principal 身份查询配置", async () => {
    const deps = dependencies();
    await expect(
      executeVideoListCapabilitiesBinding(
        { backendGroupId: "group-client" },
        apiKeyPrincipal,
        deps.value
      )
    ).rejects.toMatchObject({
      code: "validation_error",
    } satisfies Partial<OperationError>);
    expect(deps.listConfiguredModelIds).not.toHaveBeenCalled();

    await executeVideoListCapabilitiesBinding({}, apiKeyPrincipal, deps.value);
    expect(deps.listConfiguredModelIds).toHaveBeenCalledWith({
      userId: "user-1",
      apiKeyId: "key-1",
    });
  });

  it("站内用户显式分组只改变 configuredReachable", async () => {
    const deps = dependencies();
    deps.listConfiguredModelIds.mockImplementation(
      async (input: { requestedGroupId?: string }) =>
        input.requestedGroupId === "group-seedance" ? ["seedance2"] : ["sora2"]
    );

    const defaultOutput = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      deps.value
    );
    const selectedOutput = await executeVideoListCapabilitiesBinding(
      { backendGroupId: "group-seedance" },
      userPrincipal,
      deps.value
    );
    expect(deps.listConfiguredModelIds).toHaveBeenLastCalledWith({
      userId: "user-1",
      requestedGroupId: "group-seedance",
    });
    expect(defaultOutput.items.map(omitReachability)).toEqual(
      selectedOutput.items.map(omitReachability)
    );
    expect(
      defaultOutput.items.find((item) => item.model === "seedance2")
        ?.configuredReachable
    ).toBe(false);
    expect(
      selectedOutput.items.find((item) => item.model === "seedance2")
        ?.configuredReachable
    ).toBe(true);
  });

  it("旧复合变体和未知 ID 不会扩大为整个真实模型可达", async () => {
    const deps = dependencies({
      configuredModelIds: [
        "firefly-seedance2-15s-9x16-480p",
        "seedance2-15s-9x16-480p",
        "unknown-video-model",
      ],
    });
    const output = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      deps.value
    );

    expect(output.items.every((item) => !item.configuredReachable)).toBe(true);
  });

  it("显式停用的视频模型不返回能力项", async () => {
    const deps = dependencies({ configuredModelIds: ["seedance2", "sora2"] });
    deps.value.loadMarketplaceConfig = async () => ({
      version: 2,
      imageByModel: {},
      videoByFamily: {
        seedance2: {
          revision: 1,
          enabled: false,
          visible: false,
          homepageVisible: false,
          description: "",
          cover: null,
        },
      },
      customModels: [],
      writeReceipts: {},
    });

    const output = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      deps.value
    );

    expect(output.items.some((item) => item.model === "seedance2")).toBe(false);
    expect(output.items.some((item) => item.model === "sora2")).toBe(true);
  });

  it("输出采用严格公共投影，不泄露成员、凭据、健康或容量", async () => {
    const deps = dependencies({ configuredModelIds: ["seedance2"] });
    const output = await executeVideoListCapabilitiesBinding(
      {},
      userPrincipal,
      deps.value
    );
    const seedance = output.items.find((item) => item.model === "seedance2");

    expect(Object.keys(seedance ?? {})).toEqual([
      "model",
      "displayName",
      "durations",
      "aspectRatios",
      "resolutions",
      "input",
      "audio",
      "configuredReachable",
    ]);
    expect(JSON.stringify(output)).not.toMatch(
      /member|credential|cookie|token|health|cooldown|concurrency|capacity/i
    );
  });

  it.each([
    {
      version: 1,
      byModel: { seedance2: { maxReferenceImages: 0 } },
    },
    {
      version: 2,
      byModel: { seedance2: { maxReferenceImages: 20 } },
    },
    {
      version: 1,
      byModel: { unknown: { maxReferenceImages: 20 } },
    },
  ])("损坏的动态覆盖统一映射为 not_ready", async (overrides) => {
    const deps = dependencies({ overrides });

    await expect(
      executeVideoListCapabilitiesBinding({}, userPrincipal, deps.value)
    ).rejects.toMatchObject({
      code: "not_ready",
      message: "视频模型能力暂时不可用",
    } satisfies Partial<OperationError>);
    expect(deps.loadOverrides).toHaveBeenCalledTimes(1);
  });
});
