/**
 * U7 视频历史输入资产收编的 DB-free 测试。
 *
 * 覆盖任务自有对象验证、storage/remote 复制、确定性幂等重跑、半途失败恢复、源对象
 * 保留和安全输出，确保数据库与真实对象存储接入前即可证明迁移核心不变量。
 */

import { describe, expect, it } from "vitest";

import {
  type MigratedVideoInputReference,
  migrateVideoInputTask,
  type VideoInputMigrationDependencies,
  type VideoInputMigrationTask,
} from "./video-input-migration";

const CURRENT_BUCKET = "private-video-assets";

/** 构造带合法 PNG 魔数且内容可区分的测试字节。 */
function pngBytes(suffix: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(suffix),
  ]);
}

/** 内存 I/O 夹具状态。 */
type MigrationHarness = {
  clearedStaged: boolean[];
  dependencies: VideoInputMigrationDependencies;
  objects: Map<string, Buffer>;
  persisted: MigratedVideoInputReference[][];
  putKeys: string[];
  remoteReads: string[];
  setFailPutAt(callNumber: number | null): void;
  setPersistFailure(enabled: boolean): void;
};

/** 生成与真实 provider 语义一致的 bucket/key 内存身份。 */
function objectId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

/** 创建可注入写入和持久化故障的迁移夹具。 */
function createHarness(): MigrationHarness {
  const objects = new Map<string, Buffer>();
  const remotes = new Map<string, Buffer>();
  const persisted: MigratedVideoInputReference[][] = [];
  const clearedStaged: boolean[] = [];
  const putKeys: string[] = [];
  const remoteReads: string[] = [];
  let putCallCount = 0;
  let failPutAt: number | null = null;
  let persistFailure = false;

  const dependencies: VideoInputMigrationDependencies = {
    currentBucket: CURRENT_BUCKET,
    async readStorage(input) {
      const bytes = objects.get(
        objectId(input.storageBucket, input.storageKey)
      );
      if (!bytes) throw new Error("source object missing");
      return Buffer.from(bytes);
    },
    async readStorageIfExists(input) {
      const bytes = objects.get(
        objectId(input.storageBucket, input.storageKey)
      );
      return bytes ? Buffer.from(bytes) : null;
    },
    async readRemote(input) {
      remoteReads.push(input.url);
      const bytes = remotes.get(input.url);
      if (!bytes) throw new Error("remote object missing");
      return Buffer.from(bytes);
    },
    async putStorage(input) {
      putCallCount += 1;
      if (putCallCount === failPutAt) throw new Error("injected put failure");
      putKeys.push(input.storageKey);
      objects.set(
        objectId(input.storageBucket, input.storageKey),
        Buffer.from(input.data)
      );
    },
    async persistTaskInputReferences(input) {
      if (persistFailure) throw new Error("injected CAS failure");
      persisted.push(input.migratedInputImageRefs);
      clearedStaged.push(input.clearStagedInputObjects);
    },
  };

  return {
    clearedStaged,
    dependencies,
    objects,
    persisted,
    putKeys,
    remoteReads,
    setFailPutAt(callNumber) {
      failPutAt = callNumber;
    },
    setPersistFailure(enabled) {
      persistFailure = enabled;
    },
  };
}

/** 构造单输入任务快照。 */
function createTask(reference: unknown): VideoInputMigrationTask {
  return {
    id: "video-1",
    userId: "user-1",
    inputImageRefs: [reference],
  };
}

describe("migrateVideoInputTask", () => {
  it("已归一任务自有对象只验证且不改写数据库", async () => {
    const harness = createHarness();
    const storageKey =
      "user-1/video-inputs/video-1/reservation-1/first-frame.png";
    const bytes = pngBytes("normalized");
    harness.objects.set(objectId(CURRENT_BUCKET, storageKey), bytes);

    const result = await migrateVideoInputTask(
      createTask({
        source: "storage",
        mimeType: "image/png",
        storageKey,
        storageBucket: CURRENT_BUCKET,
        byteLength: bytes.byteLength,
      }),
      harness.dependencies
    );

    expect(result).toEqual({
      taskId: "video-1",
      status: "verified",
      inputCount: 1,
      copiedCount: 0,
      verifiedCount: 1,
    });
    expect(harness.putKeys).toEqual([]);
    expect(harness.persisted).toEqual([]);
  });

  it("为缺少 bucket 的任务自有对象补齐身份但不复制", async () => {
    const harness = createHarness();
    const storageKey =
      "user-1/video-inputs/video-1/reservation-1/first-frame.png";
    const bytes = pngBytes("legacy-bucket");
    harness.objects.set(objectId(CURRENT_BUCKET, storageKey), bytes);

    const result = await migrateVideoInputTask(
      createTask({
        source: "storage",
        mimeType: "image/png",
        storageKey,
        byteLength: bytes.byteLength,
      }),
      harness.dependencies
    );

    expect(result).toMatchObject({
      status: "migrated",
      copiedCount: 0,
      verifiedCount: 1,
    });
    expect(harness.persisted[0]?.[0]).toMatchObject({
      storageKey,
      storageBucket: CURRENT_BUCKET,
    });
  });

  it("任务自有对象验证成功后原子清空旧 staged 清理集合", async () => {
    const harness = createHarness();
    const attemptId = "legacy-attempt";
    const storageKey =
      `user-1/video-inputs/video-1/${attemptId}/first-frame.png`;
    const bytes = pngBytes("legacy-staged");
    harness.objects.set(objectId(CURRENT_BUCKET, storageKey), bytes);
    const task: VideoInputMigrationTask = {
      id: "video-1",
      userId: "user-1",
      inputImageRefs: [
        {
          source: "storage",
          mimeType: "image/png",
          storageKey,
          storageBucket: CURRENT_BUCKET,
          byteLength: bytes.byteLength,
        },
      ],
      stagedInputObjects: [
        {
          userId: "user-1",
          videoId: "video-1",
          attemptId,
          storageKey,
          storageBucket: CURRENT_BUCKET,
        },
      ],
    };

    const result = await migrateVideoInputTask(task, harness.dependencies);

    expect(result).toMatchObject({
      status: "migrated",
      copiedCount: 0,
      verifiedCount: 1,
    });
    expect(harness.clearedStaged).toEqual([true]);
    expect(harness.persisted).toHaveLength(1);
  });

  it("把用户历史 storage 输入复制到确定性任务前缀并保留源对象", async () => {
    const harness = createHarness();
    const sourceKey = "user-1/generations/source.png";
    const bytes = pngBytes("storage-source");
    harness.objects.set(objectId(CURRENT_BUCKET, sourceKey), bytes);

    const result = await migrateVideoInputTask(
      createTask({
        source: "storage",
        mimeType: "image/png",
        storageKey: sourceKey,
        storageBucket: CURRENT_BUCKET,
        byteLength: bytes.byteLength,
      }),
      harness.dependencies
    );

    const migrated = harness.persisted[0]?.[0];
    expect(result).toMatchObject({ status: "migrated", copiedCount: 1 });
    expect(migrated?.storageKey).toMatch(
      /^user-1\/video-inputs\/video-1\/migration-v1\/input-0-[a-f0-9]{32}\.png$/
    );
    expect(migrated?.storageBucket).toBe(CURRENT_BUCKET);
    expect(harness.objects.get(objectId(CURRENT_BUCKET, sourceKey))).toEqual(
      bytes
    );
    expect(
      harness.objects.get(objectId(CURRENT_BUCKET, migrated?.storageKey ?? ""))
    ).toEqual(bytes);
  });

  it("把 remote 输入复制到任务前缀且安全结果不含 URL 或存储身份", async () => {
    const harness = createHarness();
    const url = "https://images.example.test/private/source.png?token=secret";
    const bytes = pngBytes("remote-source");
    const remoteMap = harness.dependencies.readRemote;
    harness.dependencies.readRemote = async (input) => {
      expect(input.maxBytes).toBe(bytes.byteLength);
      expect(input.mimeType).toBe("image/png");
      harness.remoteReads.push(input.url);
      return bytes;
    };

    const result = await migrateVideoInputTask(
      createTask({
        source: "remote",
        mimeType: "image/png",
        url,
        byteLength: bytes.byteLength,
      }),
      harness.dependencies
    );
    harness.dependencies.readRemote = remoteMap;

    const serialized = JSON.stringify(result);
    expect(harness.remoteReads).toEqual([url]);
    expect(serialized).not.toContain("images.example.test");
    expect(serialized).not.toContain(CURRENT_BUCKET);
    expect(serialized).not.toContain("video-inputs");
  });

  it("中途失败不持久化半成品，重跑复用目标并完成剩余复制", async () => {
    const harness = createHarness();
    const firstKey = "user-1/generations/first.png";
    const secondKey = "user-1/generations/second.png";
    const firstBytes = pngBytes("first");
    const secondBytes = pngBytes("second");
    harness.objects.set(objectId(CURRENT_BUCKET, firstKey), firstBytes);
    harness.objects.set(objectId(CURRENT_BUCKET, secondKey), secondBytes);
    const task: VideoInputMigrationTask = {
      id: "video-1",
      userId: "user-1",
      inputImageRefs: [
        {
          source: "storage",
          mimeType: "image/png",
          storageKey: firstKey,
          storageBucket: CURRENT_BUCKET,
          byteLength: firstBytes.byteLength,
        },
        {
          source: "storage",
          mimeType: "image/png",
          storageKey: secondKey,
          storageBucket: CURRENT_BUCKET,
          byteLength: secondBytes.byteLength,
        },
      ],
    };
    harness.setFailPutAt(2);

    await expect(
      migrateVideoInputTask(task, harness.dependencies)
    ).rejects.toThrow("视频任务 video-1 的第 2 个输入写入失败");
    expect(harness.persisted).toEqual([]);
    expect(harness.putKeys).toHaveLength(1);
    expect(harness.objects.get(objectId(CURRENT_BUCKET, firstKey))).toEqual(
      firstBytes
    );
    expect(harness.objects.get(objectId(CURRENT_BUCKET, secondKey))).toEqual(
      secondBytes
    );

    harness.setFailPutAt(null);
    const result = await migrateVideoInputTask(task, harness.dependencies);

    expect(result).toMatchObject({
      status: "migrated",
      copiedCount: 1,
      verifiedCount: 1,
    });
    expect(harness.putKeys).toHaveLength(2);
    expect(harness.persisted).toHaveLength(1);
  });

  it("数据库持久化失败时保留源和目标，重跑不重复写对象", async () => {
    const harness = createHarness();
    const sourceKey = "user-1/generations/source.png";
    const bytes = pngBytes("persist-retry");
    harness.objects.set(objectId(CURRENT_BUCKET, sourceKey), bytes);
    const task = createTask({
      source: "storage",
      mimeType: "image/png",
      storageKey: sourceKey,
      storageBucket: CURRENT_BUCKET,
      byteLength: bytes.byteLength,
    });
    harness.setPersistFailure(true);

    await expect(
      migrateVideoInputTask(task, harness.dependencies)
    ).rejects.toThrow("视频任务 video-1 的输入引用持久化失败");
    expect(harness.putKeys).toHaveLength(1);
    expect(harness.objects.get(objectId(CURRENT_BUCKET, sourceKey))).toEqual(
      bytes
    );

    harness.setPersistFailure(false);
    const result = await migrateVideoInputTask(task, harness.dependencies);

    expect(result).toMatchObject({ copiedCount: 0, verifiedCount: 1 });
    expect(harness.putKeys).toHaveLength(1);
    expect(harness.persisted).toHaveLength(1);
  });

  it("拒绝其他用户或 bucket 的 storage 引用且错误不泄露对象身份", async () => {
    const harness = createHarness();
    const secretKey = "other-user/private/secret.png";

    await expect(
      migrateVideoInputTask(
        createTask({
          source: "storage",
          mimeType: "image/png",
          storageKey: secretKey,
          storageBucket: "secret-bucket",
          byteLength: pngBytes("secret").byteLength,
        }),
        harness.dependencies
      )
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        message.includes("归属校验失败") &&
        !message.includes(secretKey) &&
        !message.includes("secret-bucket")
      );
    });
    expect(harness.putKeys).toEqual([]);
    expect(harness.persisted).toEqual([]);
  });
});
