/**
 * 网站 Logo 上传服务测试。
 *
 * 验证服务把原始字节、内容类型和内容寻址引用交给存储，并在保存后失效缓存；不连接
 * 真实数据库或对象存储，数据库回执由可替换端口模拟。
 */

import { getRuntimeStorageBucketConfig } from "@repo/shared/system-settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbTransaction = vi.hoisted(() => vi.fn());
vi.mock("@repo/database", () => ({
  db: { transaction: dbTransaction },
}));
vi.mock("@repo/shared/system-settings", () => ({
  getRuntimeStorageBucketConfig: vi.fn(),
  invalidateSystemSettingsCache: vi.fn(),
}));
vi.mock("@repo/shared/storage/providers", () => ({
  getStorageProvider: vi.fn(),
}));
vi.mock("@repo/shared/logger", () => ({
  logError: vi.fn(),
}));

import { commitSiteLogoUpload, createSiteLogoUploadService } from "./service";

const input = {
  clientRequestId: "6b7d1204-3f43-4da7-b2b5-b7540927e462",
  fileName: "logo.ico",
  contentType: "image/x-icon",
  bytes: new Uint8Array([0, 0, 1, 0, 1, 0]),
};

describe("createSiteLogoUploadService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    dbTransaction.mockReset();
    vi.mocked(getRuntimeStorageBucketConfig).mockReset();
  });

  it("原样写入文件并返回内容寻址 URL", async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    const invalidateCache = vi.fn().mockResolvedValue(undefined);
    const service = createSiteLogoUploadService({
      loadBucket: vi.fn().mockResolvedValue("site-assets"),
      loadStorage: vi.fn().mockResolvedValue({
        putObject,
      }),
      validate: vi.fn().mockResolvedValue({
        bytes: input.bytes,
        sha256: "a".repeat(64),
        format: "ico",
        contentType: "image/x-icon",
        extension: "ico",
      }),
      commit: vi.fn().mockResolvedValue({
        logoUrl: `/api/storage/site-assets/logo/${"a".repeat(64)}.ico`,
        replayed: false,
      }),
      invalidateCache,
    });

    const result = await service(input, "super-admin-1");

    expect(result).toEqual({
      logoUrl: `/api/storage/site-assets/logo/${"a".repeat(64)}.ico`,
      replayed: false,
    });
    expect(putObject).toHaveBeenCalledWith(
      `logo/${"a".repeat(64)}.ico`,
      "site-assets",
      expect.any(Buffer),
      "image/x-icon"
    );
    expect(Buffer.from(putObject.mock.calls[0]?.[2] ?? [])).toEqual(
      Buffer.from(input.bytes)
    );
    expect(invalidateCache).toHaveBeenCalledOnce();
  });

  it("缓存失效失败不会吞掉错误", async () => {
    const invalidateCache = vi
      .fn()
      .mockRejectedValue(new Error("cache unavailable"));
    const service = createSiteLogoUploadService({
      loadBucket: vi.fn().mockResolvedValue("site-assets"),
      loadStorage: vi.fn().mockResolvedValue({
        putObject: vi.fn().mockResolvedValue(undefined),
      }),
      validate: vi.fn().mockResolvedValue({
        bytes: input.bytes,
        sha256: "b".repeat(64),
        format: "ico",
        contentType: "image/x-icon",
        extension: "ico",
      }),
      commit: vi.fn().mockResolvedValue({
        logoUrl: `/api/storage/site-assets/logo/${"b".repeat(64)}.ico`,
        replayed: false,
      }),
      invalidateCache,
    });

    await expect(service(input, "super-admin-1")).rejects.toThrow(
      "cache unavailable"
    );
  });

  it("网站、模型与头像资产允许共用系统公开资产 bucket", async () => {
    vi.mocked(getRuntimeStorageBucketConfig).mockResolvedValue({
      systemAssets: "system-assets",
      generations: "generations",
    });
    const putObject = vi.fn().mockResolvedValue(undefined);
    const service = createSiteLogoUploadService({
      loadStorage: vi.fn().mockResolvedValue({ putObject }),
      validate: vi.fn().mockResolvedValue({
        bytes: input.bytes,
        sha256: "c".repeat(64),
        format: "ico",
        contentType: "image/x-icon",
        extension: "ico",
      }),
      commit: vi.fn().mockResolvedValue({
        logoUrl: `/api/storage/system-assets/logo/${"c".repeat(64)}.ico`,
        replayed: false,
      }),
      invalidateCache: vi.fn().mockResolvedValue(undefined),
    });

    await expect(service(input, "super-admin-1")).resolves.toMatchObject({
      logoUrl: `/api/storage/system-assets/logo/${"c".repeat(64)}.ico`,
    });
    expect(putObject).toHaveBeenCalledWith(
      `logo/${"c".repeat(64)}.ico`,
      "system-assets",
      expect.any(Buffer),
      "image/x-icon"
    );
  });
});

describe("commitSiteLogoUpload", () => {
  it("首次请求在同一事务内写入审计回执和 Logo 设置", async () => {
    const auditInsert = {
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: "receipt" }]),
        })),
      })),
    };
    const settingInsert = {
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      })),
    };
    const transaction = {
      insert: vi
        .fn()
        .mockReturnValueOnce(auditInsert)
        .mockReturnValueOnce(settingInsert),
    };
    dbTransaction.mockImplementation(async (work) => work(transaction));

    await expect(
      commitSiteLogoUpload({
        actorUserId: "super-admin-1",
        clientRequestId: input.clientRequestId,
        requestHash: "a".repeat(64),
        logoUrl: "/api/storage/site-assets/logo/a.svg",
        reference: { bucket: "site-assets", key: `logo/${"a".repeat(64)}.svg` },
        contentType: "image/svg+xml",
      })
    ).resolves.toEqual({
      logoUrl: "/api/storage/site-assets/logo/a.svg",
      replayed: false,
    });
    expect(transaction.insert).toHaveBeenCalledTimes(2);
  });

  it("同一请求 ID 重放时返回持久化回执，不会再次写设置", async () => {
    const auditInsert = {
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const transaction = {
      insert: vi.fn().mockReturnValue(auditInsert),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                metadata: { requestHash: "a".repeat(64) },
                after: { logoUrl: "/api/storage/site-assets/logo/a.svg" },
              },
            ]),
          })),
        })),
      })),
    };
    dbTransaction.mockImplementation(async (work) => work(transaction));

    await expect(
      commitSiteLogoUpload({
        actorUserId: "super-admin-1",
        clientRequestId: input.clientRequestId,
        requestHash: "a".repeat(64),
        logoUrl: "/api/storage/site-assets/logo/a.svg",
        reference: { bucket: "site-assets", key: `logo/${"a".repeat(64)}.svg` },
        contentType: "image/svg+xml",
      })
    ).resolves.toEqual({
      logoUrl: "/api/storage/site-assets/logo/a.svg",
      replayed: true,
    });
    expect(transaction.insert).toHaveBeenCalledTimes(1);
  });

  it("同一请求 ID 携带不同文件哈希时拒绝幂等冲突", async () => {
    const auditInsert = {
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const transaction = {
      insert: vi.fn().mockReturnValue(auditInsert),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                metadata: { requestHash: "a".repeat(64) },
                after: { logoUrl: "/api/storage/site-assets/logo/a.svg" },
              },
            ]),
          })),
        })),
      })),
    };
    dbTransaction.mockImplementation(async (work) => work(transaction));

    await expect(
      commitSiteLogoUpload({
        actorUserId: "super-admin-1",
        clientRequestId: input.clientRequestId,
        requestHash: "b".repeat(64),
        logoUrl: "/api/storage/site-assets/logo/b.svg",
        reference: { bucket: "site-assets", key: `logo/${"b".repeat(64)}.svg` },
        contentType: "image/svg+xml",
      })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
