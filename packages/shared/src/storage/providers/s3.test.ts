/**
 * S3 client 网络配置、指纹缓存与密钥轮换的 DB-free 单测。
 *
 * mock AWS SDK、Node HTTP handler 和预签名器，验证超时、取消信号与连接复用；
 * secret、endpoint 变化后创建新 client 并销毁旧连接。测试仅使用虚构密钥。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageRuntimeConfig } from "./runtime-config";

interface MockClientInstance {
  config: unknown;
  destroy: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

interface MockHttpHandlerInstance {
  options: unknown;
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

const smithyMocks = vi.hoisted(() => {
  const handlers: MockHttpHandlerInstance[] = [];

  class MockNodeHttpHandler implements MockHttpHandlerInstance {
    options: unknown;

    constructor(options: unknown) {
      this.options = options;
      handlers.push(this);
    }
  }

  return { handlers, MockNodeHttpHandler };
});

const presign = vi.hoisted(() => vi.fn(async () => "https://signed.test"));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: awsMocks.MockS3Client,
  AbortMultipartUploadCommand: class AbortMultipartUploadCommand extends awsMocks.MockCommand {},
  CompleteMultipartUploadCommand: class CompleteMultipartUploadCommand extends awsMocks.MockCommand {},
  CreateMultipartUploadCommand: class CreateMultipartUploadCommand extends awsMocks.MockCommand {},
  DeleteObjectCommand: awsMocks.MockCommand,
  GetObjectCommand: awsMocks.MockCommand,
  ListMultipartUploadsCommand: class ListMultipartUploadsCommand extends awsMocks.MockCommand {},
  ListObjectsV2Command: class ListObjectsV2Command extends awsMocks.MockCommand {},
  PutObjectCommand: awsMocks.MockCommand,
  UploadPartCommand: class UploadPartCommand extends awsMocks.MockCommand {},
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: presign,
}));

vi.mock("@smithy/node-http-handler", () => ({
  NodeHttpHandler: smithyMocks.MockNodeHttpHandler,
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
    smithyMocks.handlers.length = 0;
    presign.mockClear();
  });

  it("client 使用显式网络超时且对象请求保留取消信号", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const provider = createS3StorageProvider(createConfig());
    const controller = new AbortController();

    await provider.putObject(
      "a.txt",
      "uploads",
      Buffer.from("content"),
      "text/plain",
      { signal: controller.signal }
    );

    expect(smithyMocks.handlers).toHaveLength(1);
    expect(smithyMocks.handlers[0]?.options).toEqual({
      connectionTimeout: 10_000,
      socketTimeout: 120_000,
    });
    expect(awsMocks.clients[0]?.config).toMatchObject({
      requestHandler: smithyMocks.handlers[0],
    });
    expect(awsMocks.clients[0]?.send).toHaveBeenCalledWith(expect.anything(), {
      abortSignal: controller.signal,
    });
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

  it("按 opaque cursor 分页枚举对象", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const provider = createS3StorageProvider(createConfig());
    await provider.getSignedUploadUrl("warmup", "uploads", "text/plain");
    const client =
      awsMocks.clients[0] ??
      (() => {
        throw new Error("missing client");
      })();
    client.send.mockResolvedValueOnce({
      Contents: [
        {
          Key: "operations-exports/task-1/lease-1.csv",
          LastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
      ],
      NextContinuationToken: "next-token",
    });
    if (!provider.listObjects) throw new Error("missing list capability");

    await expect(
      provider.listObjects("operations-exports/", "uploads", {
        cursor: "current-token",
        limit: 25,
      })
    ).resolves.toEqual({
      objects: [
        {
          key: "operations-exports/task-1/lease-1.csv",
          lastModified: new Date("2026-02-01T00:00:00.000Z"),
        },
      ],
      nextCursor: "next-token",
    });
    expect(
      (client.send.mock.calls.at(-1)?.[0] as { input: unknown }).input
    ).toMatchObject({
      Bucket: "uploads",
      Prefix: "operations-exports/",
      ContinuationToken: "current-token",
      MaxKeys: 25,
    });
  });

  it("分页扫描并终止安全窗口前的未完成 multipart", async () => {
    const { createS3StorageProvider } = await import("./s3");
    const provider = createS3StorageProvider(createConfig());
    await provider.getSignedUploadUrl("warmup", "uploads", "text/plain");
    const client =
      awsMocks.clients[0] ??
      (() => {
        throw new Error("missing client");
      })();
    client.send
      .mockResolvedValueOnce({
        Uploads: [
          {
            Key: "operations-exports/task-1/old.csv",
            UploadId: "old-upload",
            Initiated: new Date("2026-02-01T00:00:00.000Z"),
          },
          {
            Key: "operations-exports/task-2/young.csv",
            UploadId: "young-upload",
            Initiated: new Date("2026-02-08T00:00:00.000Z"),
          },
        ],
        IsTruncated: true,
        NextKeyMarker: "next-key",
        NextUploadIdMarker: "next-upload",
      })
      .mockResolvedValueOnce({});
    if (!provider.listMultipartUploads || !provider.abortMultipartUpload) {
      throw new Error("missing multipart cleanup capabilities");
    }

    const result = await provider.listMultipartUploads(
      "operations-exports/",
      "uploads",
      { limit: 20 }
    );

    expect(result.uploads).toHaveLength(2);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(client.send).toHaveBeenCalledTimes(1);
    await provider.abortMultipartUpload(
      result.uploads[0]?.key ?? "",
      "uploads",
      result.uploads[0]?.cleanupToken ?? ""
    );
    expect(
      (client.send.mock.calls[1]?.[0] as { input: unknown }).input
    ).toMatchObject({
      Bucket: "uploads",
      Key: "operations-exports/task-1/old.csv",
      UploadId: "old-upload",
    });
    client.send.mockResolvedValueOnce({ Uploads: [], IsTruncated: false });
    await provider.listMultipartUploads("operations-exports/", "uploads", {
      cursor: result.nextCursor,
      limit: 20,
    });
    expect(
      (client.send.mock.calls[2]?.[0] as { input: unknown }).input
    ).toMatchObject({
      KeyMarker: "next-key",
      UploadIdMarker: "next-upload",
    });
  });
});
