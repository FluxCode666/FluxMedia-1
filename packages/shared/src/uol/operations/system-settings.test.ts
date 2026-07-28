/**
 * 通用系统设置 UOL 操作测试。
 *
 * 职责：锁定管理面板完整脱敏快照、数组式 clear 写入语义和超级管理员权限，
 * 防止传输层再次直接调用设置 service 或丢失定义元数据。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertAccess } from "../access";

const mocks = vi.hoisted(() => ({
  destroyGenerationPhotosByMaxCount: vi.fn(),
  getAdminSystemSettingsSnapshot: vi.fn(),
  getPaginationConfig: vi.fn(),
  getSiteBranding: vi.fn(),
  setSiteLogoUrl: vi.fn(),
  setSystemSettings: vi.fn(),
  shouldRunMaxCountCleanupOnSettingsChange: vi.fn(),
}));

vi.mock("../../generation-maintenance", () => ({
  destroyGenerationPhotosByMaxCount: mocks.destroyGenerationPhotosByMaxCount,
  shouldRunMaxCountCleanupOnSettingsChange:
    mocks.shouldRunMaxCountCleanupOnSettingsChange,
}));
vi.mock("../../logger", () => ({ logError: vi.fn() }));
vi.mock("../../pagination/server", () => ({
  getPaginationConfig: mocks.getPaginationConfig,
}));
vi.mock("../../system-settings/bootstrap", () => ({
  bootstrapSystemSettingsEnv: vi.fn(),
}));
vi.mock("../../system-settings/env-file", () => ({
  syncSystemSettingsToEnvFiles: vi.fn(),
}));
vi.mock("../../system-settings/index", () => ({
  getAdminSystemSettingsSnapshot: mocks.getAdminSystemSettingsSnapshot,
  getRuntimeSettingJson: vi.fn(),
  getSiteBranding: mocks.getSiteBranding,
  getSystemSettingValue: vi.fn(),
  importSystemSettingsFromEnv: vi.fn(),
  initializeMissingSystemSettingsDefaults: vi.fn(),
  setSiteLogoUrl: mocks.setSiteLogoUrl,
  setSystemSettings: mocks.setSystemSettings,
}));

import {
  settingsGetPaginationConfig,
  settingsGetSiteBranding,
  settingsGetSnapshot,
  settingsSetSiteLogo,
  settingsUpdate,
} from "./system-settings";

const superAdmin = {
  type: "user" as const,
  userId: "super-admin-1",
  role: "super_admin" as const,
};

const operationContext = {
  requestId: "system-settings-test",
  assertOwnership: vi.fn(),
};

describe("通用系统设置 UOL", () => {
  beforeEach(() => {
    mocks.destroyGenerationPhotosByMaxCount.mockReset();
    mocks.getAdminSystemSettingsSnapshot.mockReset();
    mocks.getPaginationConfig.mockReset();
    mocks.getSiteBranding.mockReset();
    mocks.setSiteLogoUrl.mockReset();
    mocks.setSystemSettings.mockReset();
    mocks.shouldRunMaxCountCleanupOnSettingsChange.mockReset();
    mocks.setSystemSettings.mockResolvedValue([]);
    mocks.getPaginationConfig.mockResolvedValue({
      defaultPageSize: 20,
      pageSizeOptions: [10, 20, 50],
    });
    mocks.getSiteBranding.mockResolvedValue({
      logoUrl: "/assets/icon.svg",
    });
    mocks.setSiteLogoUrl.mockResolvedValue({
      logoUrl: "/assets/icon.svg",
    });
    mocks.shouldRunMaxCountCleanupOnSettingsChange.mockReturnValue(false);
  });

  it("返回面板所需的完整脱敏定义快照", async () => {
    const settings = [
      {
        key: "IMAGE_BACKEND_SCHEDULING_STRATEGY",
        label: "媒体后端调度策略",
        description: "选择新获租请求使用的全局调度策略",
        category: "models" as const,
        valueType: "select" as const,
        defaultValue: "priority",
        options: [
          { label: "按优先级", value: "priority" },
          { label: "按最少调用", value: "least_acquired" },
          { label: "按最小负载", value: "least_load" },
        ],
        value: "priority",
        configured: true,
        stored: true,
        fromEnv: false,
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        key: "BETTER_AUTH_SECRET",
        label: "鉴权密钥",
        description: "服务端鉴权密钥",
        category: "auth" as const,
        valueType: "string" as const,
        secret: true,
        value: "",
        configured: true,
        stored: true,
        fromEnv: false,
        updatedAt: null,
      },
    ];
    mocks.getAdminSystemSettingsSnapshot.mockResolvedValue(settings);

    const result = await settingsGetSnapshot.execute(
      {},
      superAdmin,
      operationContext
    );

    expect(result.settings).toEqual(settings);
    expect(settingsGetSnapshot.output.parse(result)).toEqual(result);
    expect(result.settings[1]?.value).toBe("");
  });

  it("通过 system-only operation 返回分页配置", async () => {
    const systemPrincipal = {
      type: "system" as const,
      reason: "test-pagination",
    };
    const result = await settingsGetPaginationConfig.execute(
      {},
      systemPrincipal,
      operationContext
    );

    expect(result).toEqual({
      defaultPageSize: 20,
      pageSizeOptions: [10, 20, 50],
    });
    expect(settingsGetPaginationConfig.output.parse(result)).toEqual(result);
    expect(settingsGetPaginationConfig.agentExposure).toBe("human-only");
    expect(() =>
      assertAccess(settingsGetPaginationConfig.access, systemPrincipal)
    ).not.toThrow();
    expect(() =>
      assertAccess(settingsGetPaginationConfig.access, superAdmin)
    ).toThrow();
  });

  it("通过 system-only operation 返回安全站点品牌 DTO", async () => {
    const systemPrincipal = {
      type: "system" as const,
      reason: "test-site-branding",
    };
    mocks.getSiteBranding.mockResolvedValue({
      logoUrl: "https://cdn.example.com/logo.webp",
    });

    const result = await settingsGetSiteBranding.execute(
      {},
      systemPrincipal,
      operationContext
    );

    expect(result).toEqual({
      logoUrl: "https://cdn.example.com/logo.webp",
    });
    expect(settingsGetSiteBranding.output.parse(result)).toEqual(result);
    expect(settingsGetSiteBranding.agentExposure).toBe("human-only");
    expect(() =>
      assertAccess(settingsGetSiteBranding.access, systemPrincipal)
    ).not.toThrow();
    expect(() =>
      assertAccess(settingsGetSiteBranding.access, superAdmin)
    ).toThrow();
  });

  it("只有真实超级管理员可通过专用 operation 保存 Logo", async () => {
    mocks.setSiteLogoUrl.mockResolvedValue({
      logoUrl: "/assets/brand/logo.svg",
    });
    const input = { logoUrl: "/assets/brand/logo.svg" };

    const result = await settingsSetSiteLogo.execute(
      input,
      superAdmin,
      operationContext
    );

    expect(result).toEqual(input);
    expect(mocks.setSiteLogoUrl).toHaveBeenCalledWith(
      "/assets/brand/logo.svg",
      "super-admin-1"
    );
    expect(settingsSetSiteLogo.output.parse(result)).toEqual(result);
    expect(settingsSetSiteLogo.idempotency).toEqual({ kind: "natural" });
    expect(settingsSetSiteLogo.sideEffects).toEqual(["cache"]);
    expect(() =>
      assertAccess(settingsSetSiteLogo.access, superAdmin)
    ).not.toThrow();
    for (const principal of [
      { type: "system" as const, reason: "must-not-bypass" },
      {
        type: "user" as const,
        userId: "admin-1",
        role: "admin" as const,
      },
    ]) {
      expect(() =>
        assertAccess(settingsSetSiteLogo.access, principal)
      ).toThrow();
    }
  });

  it("专用 Logo 写入 schema 拒绝危险地址和多余字段", () => {
    expect(settingsSetSiteLogo.input.safeParse({ logoUrl: null }).success).toBe(
      true
    );
    expect(
      settingsSetSiteLogo.input.safeParse({
        logoUrl: "javascript:alert(1)",
      }).success
    ).toBe(false);
    expect(
      settingsSetSiteLogo.input.safeParse({
        logoUrl: "/assets/logo.svg",
        injected: true,
      }).success
    ).toBe(false);
  });

  it("以数组写入值与清空指令并保留清空回退语义", async () => {
    mocks.setSystemSettings.mockResolvedValue([
      "NEXT_PUBLIC_APP_NAME",
      "IMAGE_BACKEND_SCHEDULING_STRATEGY",
    ]);

    const result = await settingsUpdate.execute(
      {
        updates: [
          { key: "NEXT_PUBLIC_APP_NAME", value: "Flux" },
          {
            key: "IMAGE_BACKEND_SCHEDULING_STRATEGY",
            clear: true,
          },
        ],
      },
      superAdmin,
      operationContext
    );

    expect(mocks.setSystemSettings).toHaveBeenCalledWith(
      [
        { key: "NEXT_PUBLIC_APP_NAME", value: "Flux" },
        {
          key: "IMAGE_BACKEND_SCHEDULING_STRATEGY",
          value: undefined,
          clear: true,
        },
      ],
      "super-admin-1"
    );
    expect(result).toEqual({
      success: true,
      changedKeys: [
        "NEXT_PUBLIC_APP_NAME",
        "IMAGE_BACKEND_SCHEDULING_STRATEGY",
      ],
    });
  });

  it("拒绝含糊或带未知字段的设置更新", () => {
    expect(
      settingsUpdate.input.safeParse({ updates: [{ key: "A" }] }).success
    ).toBe(false);
    expect(
      settingsUpdate.input.safeParse({
        updates: [{ key: "A", value: 1, clear: true }],
      }).success
    ).toBe(false);
    expect(
      settingsUpdate.input.safeParse({
        updates: [{ key: "A", value: 1, injected: true }],
      }).success
    ).toBe(false);
  });

  it("只允许超级管理员读取和写入通用设置", () => {
    for (const operation of [settingsGetSnapshot, settingsUpdate]) {
      expect(() => assertAccess(operation.access, superAdmin)).not.toThrow();
      expect(() =>
        assertAccess(operation.access, {
          type: "user",
          userId: "admin-1",
          role: "admin",
        })
      ).toThrow();
    }
  });
});
