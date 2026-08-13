/**
 * S3 client 配置指纹缓存与密钥轮换的 DB-free 单测。
 *
 * mock AWS SDK 和预签名器，验证相同配置复用连接；secret、endpoint 变化后创建
 * 新 client 并销毁旧连接。测试仅使用虚构密钥，且不输出配置指纹。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageRuntimeConfig } from "./runtime-config";

interface MockClientInstance {
  config: unknown;
  destroy: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

const awsMocks = vi.hoisted(() => {
  const clients: MockClientInstance[] = [];

  class MockS3Client implements MockClientInstance {
    config: unknown;
    destroy = vi.fn();
    send = vi.fn();

    constructor(config: unknown) {
      this.config = config;
      clients.push(this);
    }
  }

  class MockCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return { clients, MockS3Client, MockCommand };
});

const presign = vi.hoisted(() => vi.fn(async () => "https://signed.test"));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: awsMocks.MockS3Client,
  AbortMultipartUploadCommand: class AbortMultipartUploadCommand extends awsMocks.MockCommand {},
  CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand extends awsMocks.MockCommand {},
  CreateMultipartUploadCommand: class CreateMultipartUploadCommand extends awsMocks.MockCommand {},
  DeleteObjectCommand: awsMocks.MockCommand,
  GetObjectCommand: awsMocks.MockCommand,
  PutObjectCommand: awsMocks.MockCommand,
  UploadPartCommand: class UploadPartCommand extends awsMocks.MockCommand {},
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: presign,
}));

// s3.ts 为兼容直连 provider 保留动态配置读取；本组只测显式配置工厂，因此
// mock 掉 system-settings，确保单测不会触达数据库。
vi.mock("../../system-settings", () => ({
  getRuntimeSettingString: vi.fn(async () => null),
}));

/** 构造一份完整且仅用于测试的 S3 配置。 */
function createConfig(
  overrides: Partial<StorageRuntimeConfig> = {}
): StorageRuntimeConfig {
  return {
    endpoint: "https://s3-a.example.com",
    region: "auto",
    accessKeyId: "test-access-a",
    secretAccessKey: "test-secret-a",
    bucketName: "uploads",
    localStoragePath: "./storage",
    ...overrides,
  };
}

describe("S3 client 动态配置", () => {
  beforeEach(async () => {
    const { destroyCachedS3Client } = await import("./s3");
    destroyCachedS3Client();
    awsMocks.clients.length = 0;
    presign.mockClear();
  });

  it("相同连接配置复用 client，bucket 变化不重建连接", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const firstProvider = createS3StorageProvider(createConfig());
    const secondProvider = createS3StorageProvider(
      createConfig({ bucketName: "uploads-b" })
    );

    await firstProvider.getSignedUploadUrl("a.txt", "uploads", "text/plain");
    await secondProvider.getSignedUploadUrl("b.txt", "uploads-b", "text/plain");

    expect(awsMocks.clients).toHaveLength(1);
    expect(awsMocks.clients[0]?.destroy).not.toHaveBeenCalled();
  });

  it("secret 和 endpoint 轮换后依次销毁旧 client 并创建新 client", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const firstProvider = createS3StorageProvider(createConfig());
    await firstProvider.getSignedUploadUrl("a.txt", "uploads", "text/plain");

    const afterSecretRotation = createS3StorageProvider(
      createConfig({ secretAccessKey: "test-secret-b" })
    );
    await afterSecretRotation.getSignedUploadUrl(
      "b.txt",
      "uploads",
      "text/plain"
    );

    const afterEndpointRotation = createS3StorageProvider(
      createConfig({
        endpoint: "https://s3-b.example.com",
        secretAccessKey: "test-secret-b",
      })
    );
    await afterEndpointRotation.getSignedUploadUrl(
      "c.txt",
      "uploads",
      "text/plain"
    );

    expect(awsMocks.clients).toHaveLength(3);
    expect(awsMocks.clients[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(awsMocks.clients[1]?.destroy).toHaveBeenCalledTimes(1);
    expect(awsMocks.clients[2]?.destroy).not.toHaveBeenCalled();
  });

  it("流式写入使用 multipart，并在成功后 complete", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const provider = createS3StorageProvider(createConfig());
    await provider.getSignedUploadUrl("warmup", "uploads", "text/plain");
    const client =
      awsMocks.clients[0] ??
      (() => {
        throw new Error("missing client");
      })();
    client.send
      .mockResolvedValueOnce({ UploadId: "upload-1" })
      .mockResolvedValueOnce({ ETag: "etag-1" })
      .mockResolvedValueOnce({});
    if (!provider.putObjectStream) throw new Error("missing stream capability");
    await provider.putObjectStream(
      "export.csv",
      "uploads",
      (async function* () {
        yield Buffer.from("a,b\r\n");
      })(),
      "text/csv"
    );
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(
      (client.send.mock.calls[0]?.[0] as { input: unknown }).input
    ).toMatchObject({ Bucket: "uploads", Key: "export.csv" });
    expect(
      (client.send.mock.calls[2]?.[0] as { input: unknown }).input
    ).toMatchObject({ UploadId: "upload-1" });
  });

  it("multipart 上传失败后尽力 abort 并原样抛错", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const provider = createS3StorageProvider(createConfig());
    await provider.getSignedUploadUrl("warmup", "uploads", "text/plain");
    const client =
      awsMocks.clients[0] ??
      (() => {
        throw new Error("missing client");
      })();
    client.send
      .mockResolvedValueOnce({ UploadId: "upload-2" })
      .mockRejectedValueOnce(new Error("part failed"))
      .mockResolvedValueOnce({});
    if (!provider.putObjectStream) throw new Error("missing stream capability");
    await expect(
      provider.putObjectStream(
        "export.csv",
        "uploads",
        (async function* () {
          yield Buffer.from("broken");
        })(),
        "text/csv"
      )
    ).rejects.toThrow("part failed");
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(
      (client.send.mock.calls[2]?.[0] as { input: unknown }).input
    ).toMatchObject({ UploadId: "upload-2" });
  });
});
