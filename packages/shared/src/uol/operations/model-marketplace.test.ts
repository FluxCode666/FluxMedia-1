/**
 * 模型配置与模型广场 UOL 契约测试。
 *
 * 使用方：Vitest；锁定管理读取、单条目写入与公开目录的角色、幂等、Agent 暴露和严格
 * DTO 边界，避免后续 Web binding 或传输层绕开统一接口层。
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ||=
    "postgres://test:test@127.0.0.1:5432/fluxmedia_test";
});

import {
  modelConfigurationSnapshotSchema,
  updateModelConfigurationEntryInputSchema,
  updateModelConfigurationEntryOutputSchema,
} from "../../model-marketplace";
import { assertAccess } from "../access";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { isOperationBound } from "../registry";
import {
  modelMarketplaceListPublicModels,
  modelMarketplacePublicCatalogOutputSchema,
  settingsGetModelConfiguration,
  settingsUpdateModelConfigurationEntry,
} from "./model-marketplace";

const userPrincipal = {
  type: "user",
  userId: "user-1",
  role: "user",
} satisfies Principal;
const adminPrincipal = {
  type: "user",
  userId: "admin-1",
  role: "admin",
} satisfies Principal;
const observerPrincipal = {
  type: "user",
  userId: "observer-1",
  role: "observer_admin",
} satisfies Principal;
const superAdminPrincipal = {
  type: "user",
  userId: "super-admin-1",
  role: "super_admin",
} satisfies Principal;
const systemPrincipal = {
  type: "system",
  reason: "model-marketplace-read",
} satisfies Principal;

const IMAGE_PRICING = {
  base1024Credits: 1.27,
  base1kCredits: 1.27,
  base2kCredits: 5.07,
  base4kCredits: 10,
};
const VALID_IMAGE_UPDATE = {
  clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
  category: "image",
  configKey: "gpt-image-2",
  expectedRevision: 0,
  visible: true,
  description: "",
  coverChange: { action: "keep" },
  pricing: IMAGE_PRICING,
};

describe("模型配置 UOL 元数据", () => {
  it("注册管理员只读配置快照且不向 Agent 暴露", () => {
    expect(settingsGetModelConfiguration).toMatchObject({
      name: "settings.getModelConfiguration",
      domain: "system-settings",
      access: { kind: "admin" },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(() =>
      assertAccess(settingsGetModelConfiguration.access, observerPrincipal)
    ).not.toThrow();
    expect(() =>
      assertAccess(settingsGetModelConfiguration.access, adminPrincipal)
    ).not.toThrow();
    expect(() =>
      assertAccess(settingsGetModelConfiguration.access, userPrincipal)
    ).toThrow();
    expect(settingsGetModelConfiguration.output).toBe(
      modelConfigurationSnapshotSchema
    );
  });

  it("只允许真实超级管理员执行单条目幂等写入", () => {
    expect(settingsUpdateModelConfigurationEntry).toMatchObject({
      name: "settings.updateModelConfigurationEntry",
      domain: "system-settings",
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
    });
    expect(() =>
      assertAccess(
        settingsUpdateModelConfigurationEntry.access,
        superAdminPrincipal
      )
    ).not.toThrow();
    for (const principal of [
      userPrincipal,
      adminPrincipal,
      observerPrincipal,
      systemPrincipal,
    ]) {
      expect(() =>
        assertAccess(settingsUpdateModelConfigurationEntry.access, principal)
      ).toThrow();
    }
    expect(settingsUpdateModelConfigurationEntry.input).toBe(
      updateModelConfigurationEntryInputSchema
    );
    expect(settingsUpdateModelConfigurationEntry.output).toBe(
      updateModelConfigurationEntryOutputSchema
    );
  });

  it("公开目录只允许 system Principal 进程内读取", () => {
    expect(modelMarketplaceListPublicModels).toMatchObject({
      name: "modelMarketplace.listPublicModels",
      domain: "external-api",
      access: { kind: "system" },
      agentExposure: "human-only",
      readOnly: true,
      destructive: false,
      idempotency: { kind: "natural" },
      sideEffects: [],
    });
    expect(() =>
      assertAccess(modelMarketplaceListPublicModels.access, systemPrincipal)
    ).not.toThrow();
    expect(() =>
      assertAccess(modelMarketplaceListPublicModels.access, superAdminPrincipal)
    ).toThrow();
  });

  it("未绑定时由真实网关保持先鉴权后返回 not_implemented", async () => {
    for (const name of [
      "settings.getModelConfiguration",
      "settings.updateModelConfigurationEntry",
      "modelMarketplace.listPublicModels",
    ]) {
      expect(isOperationBound(name)).toBe(false);
    }

    await expect(
      invokeOperation("settings.getModelConfiguration", {}, adminPrincipal, {
        requestId: "model-config-read",
      })
    ).rejects.toMatchObject({ code: "not_implemented" });
    await expect(
      invokeOperation(
        "settings.updateModelConfigurationEntry",
        VALID_IMAGE_UPDATE,
        systemPrincipal,
        { requestId: "model-config-system-write" }
      )
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      invokeOperation(
        "settings.updateModelConfigurationEntry",
        VALID_IMAGE_UPDATE,
        superAdminPrincipal,
        { requestId: "model-config-super-admin-write" }
      )
    ).rejects.toMatchObject({ code: "not_implemented" });
    await expect(
      invokeOperation(
        "modelMarketplace.listPublicModels",
        {},
        systemPrincipal,
        { requestId: "model-marketplace-read" }
      )
    ).rejects.toMatchObject({ code: "not_implemented" });
  });
});

describe("模型配置 UOL schema", () => {
  it("所有读取输入均拒绝未知字段", () => {
    expect(settingsGetModelConfiguration.input.safeParse({}).success).toBe(
      true
    );
    expect(
      settingsGetModelConfiguration.input.safeParse({ injected: true }).success
    ).toBe(false);
    expect(modelMarketplaceListPublicModels.input.safeParse({}).success).toBe(
      true
    );
    expect(
      modelMarketplaceListPublicModels.input.safeParse({ injected: true })
        .success
    ).toBe(false);
  });

  it("写入输入复用严格单模型契约", () => {
    expect(
      settingsUpdateModelConfigurationEntry.input.safeParse(VALID_IMAGE_UPDATE)
        .success
    ).toBe(true);
    expect(
      settingsUpdateModelConfigurationEntry.input.safeParse({
        ...VALID_IMAGE_UPDATE,
        bucket: "model-marketplace",
      }).success
    ).toBe(false);
    expect(
      settingsUpdateModelConfigurationEntry.input.safeParse({
        ...VALID_IMAGE_UPDATE,
        coverChange: { action: "replace", url: "/cover.webp" },
      }).success
    ).toBe(false);
  });

  it("管理输出严格拒绝 bucket、key 与未知字段", () => {
    const valid = {
      canEdit: false,
      runtimeCatalogStatus: "ready",
      entries: [
        {
          category: "image",
          configKey: "gpt-image-2",
          displayName: "GPT Image 2",
          iconKey: "openai",
          revision: 0,
          marketplaceApplicable: true,
          visible: true,
          description: "",
          coverUrl: "/model-marketplace/default-image.webp",
          usesDefaultCover: true,
          pricingSource: "explicit",
          pricing: IMAGE_PRICING,
          minimumCredits: 1.27,
        },
      ],
    };

    expect(settingsGetModelConfiguration.output.safeParse(valid).success).toBe(
      true
    );
    expect(
      settingsGetModelConfiguration.output.safeParse({
        ...valid,
        entries: [{ ...valid.entries[0], key: "private/object.webp" }],
      }).success
    ).toBe(false);
  });

  it("公开输出区分正常空目录并拒绝任何内部字段", () => {
    expect(
      modelMarketplacePublicCatalogOutputSchema.parse({ items: [] })
    ).toEqual({ items: [] });
    expect(() =>
      modelMarketplacePublicCatalogOutputSchema.parse({
        items: [
          {
            category: "image",
            configKey: "gpt-image-2",
            defaultModelId: "gpt-image-2",
            displayName: "GPT Image 2",
            iconKey: "openai",
            description: "",
            coverUrl: "/model-marketplace/default-image.webp",
            minimumCredits: 1.27,
            priceUnit: "per_image",
            pricing: IMAGE_PRICING,
            bucket: "model-marketplace",
          },
        ],
      })
    ).toThrow();
    expect(() =>
      modelMarketplacePublicCatalogOutputSchema.parse({
        items: [],
        runtimeError: "secret backend detail",
      })
    ).toThrow();
  });
});
