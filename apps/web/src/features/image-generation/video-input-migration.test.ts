/**
 * U7 视频历史输入资产收编的 DB-free 测试。
 *
 * 覆盖任务自有对象验证、storage/remote 复制、确定性幂等重跑、半途失败恢复、源对象
 * 保留和安全输出，确保数据库与真实对象存储接入前即可证明迁移核心不变量。
 */

import { chmod, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type MigratedVideoInputReference,
  migrateVideoInputTask,
  openVideoInputRollbackJournal,
  parseVideoInputMigrationCliArguments,
  parseVideoInputRollbackManifest,
  readVideoInputRollbackJournal,
  rollbackVideoInputAssets,
  type VideoInputMigrationDependencies,
  type VideoInputMigrationTask,
  type VideoInputRollbackRecord,
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
  rollbackRecords: VideoInputRollbackRecord[];
  writeEvents: string[];
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
  const rollbackRecords: VideoInputRollbackRecord[] = [];
  const writeEvents: string[] = [];
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
      writeEvents.push(`put:${input.storageKey}`);
      putKeys.push(input.storageKey);
      objects.set(
        objectId(input.storageBucket, input.storageKey),
        Buffer.from(input.data)
      );
    },
    async recordRollbackTarget(record) {
      writeEvents.push(`record:${record.key}`);
      rollbackRecords.push(record);
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
    rollbackRecords,
    writeEvents,
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
    expect(harness.rollbackRecords).toEqual([]);
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
    expect(harness.rollbackRecords).toEqual([]);
  });

  it("任务自有对象验证成功后原子清空旧 staged 清理集合", async () => {
    const harness = createHarness();
    const attemptId = "legacy-attempt";
    const storageKey = `user-1/video-inputs/video-1/${attemptId}/first-frame.png`;
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
    expect(harness.rollbackRecords).toEqual([
      {
        schemaVersion: 1,
        bucket: CURRENT_BUCKET,
        key: migrated?.storageKey,
      },
    ]);
    expect(harness.writeEvents).toEqual([
      `record:${migrated?.storageKey}`,
      `put:${migrated?.storageKey}`,
    ]);
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
    expect(JSON.stringify(harness.rollbackRecords)).not.toContain(
      "images.example.test"
    );
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
    expect(harness.rollbackRecords).toHaveLength(2);
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
    expect(harness.rollbackRecords).toHaveLength(3);
    expect(harness.rollbackRecords[0]?.key).not.toBe(
      harness.rollbackRecords[1]?.key
    );
    expect(harness.rollbackRecords[1]?.key).toBe(
      harness.rollbackRecords[2]?.key
    );
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
    expect(harness.rollbackRecords).toHaveLength(1);
    expect(harness.objects.get(objectId(CURRENT_BUCKET, sourceKey))).toEqual(
      bytes
    );

    harness.setPersistFailure(false);
    const result = await migrateVideoInputTask(task, harness.dependencies);

    expect(result).toMatchObject({ copiedCount: 0, verifiedCount: 1 });
    expect(harness.putKeys).toHaveLength(1);
    expect(harness.rollbackRecords).toHaveLength(1);
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

describe("parseVideoInputMigrationCliArguments", () => {
  const manifestPath = "/var/lib/fluxmedia/video-input-rollback.ndjson";

  it("要求迁移模式显式提供旧写入者退出确认和绝对清单路径", () => {
    expect(
      parseVideoInputMigrationCliArguments([
        "migrate",
        "--confirm-no-legacy-writers",
        "--rollback-manifest",
        manifestPath,
      ])
    ).toEqual({ mode: "migrate", rollbackManifestPath: manifestPath });
  });

  it("要求回滚模式显式确认数据库已经恢复", () => {
    expect(
      parseVideoInputMigrationCliArguments([
        "rollback",
        "--confirm-database-restored",
        "--rollback-manifest",
        manifestPath,
      ])
    ).toEqual({ mode: "rollback", rollbackManifestPath: manifestPath });
  });

  it.each([
    ["migrate", "--confirm-no-legacy-writers"],
    [
      "migrate",
      "--confirm-no-legacy-writers",
      "--rollback-manifest",
      "relative.ndjson",
    ],
    [
      "rollback",
      "--confirm-no-legacy-writers",
      "--rollback-manifest",
      manifestPath,
    ],
    [
      "rollback",
      "--confirm-database-restored",
      "--rollback-manifest",
      manifestPath,
      "--extra",
    ],
  ])("拒绝缺失、相对、错误确认或额外参数 %#", (...argumentsList) => {
    expect(() => parseVideoInputMigrationCliArguments(argumentsList)).toThrow(
      /参数无效|路径无效/
    );
  });
});

describe("parseVideoInputRollbackManifest", () => {
  const record = {
    schemaVersion: 1,
    bucket: CURRENT_BUCKET,
    key: "user-1/video-inputs/video-1/migration-v1/input-0-0123456789abcdef0123456789abcdef.png",
  } as const;

  it("严格解析只含版本、bucket 和 migration-v1 key 的 NDJSON", () => {
    expect(
      parseVideoInputRollbackManifest(
        `${JSON.stringify(record)}\n${JSON.stringify({ ...record, key: record.key.replace("input-0", "input-1") })}\n`
      )
    ).toEqual([
      record,
      { ...record, key: record.key.replace("input-0", "input-1") },
    ]);
    expect(parseVideoInputRollbackManifest("")).toEqual([]);
  });

  it.each([
    `${JSON.stringify({ ...record, url: "https://secret.example" })}\n`,
    `${JSON.stringify({ ...record, schemaVersion: 2 })}\n`,
    `${JSON.stringify({ ...record, key: "user-1/generations/source.png" })}\n`,
    `${JSON.stringify({ ...record, key: record.key.replace("migration-v1", "reservation-1") })}\n`,
    `${JSON.stringify(record)}\n\n`,
    "not-json\n",
  ])("拒绝越权、扩展字段、错误版本、空行或非法 JSON %#", (content) => {
    expect(() => parseVideoInputRollbackManifest(content)).toThrow();
  });
});

describe("video input rollback journal", () => {
  const record = {
    schemaVersion: 1,
    bucket: CURRENT_BUCKET,
    key: "user-1/video-inputs/video-1/migration-v1/input-0-0123456789abcdef0123456789abcdef.png",
  } as const;

  it("以 0600 append-only NDJSON 持久记录并可继续幂等迁移", async () => {
    const directory = await mkdtemp(join(tmpdir(), "video-input-rollback-"));
    const manifestPath = join(directory, "rollback.ndjson");
    try {
      const journal = await openVideoInputRollbackJournal(
        manifestPath,
        CURRENT_BUCKET
      );
      expect(journal.existingRecordCount).toBe(0);
      await journal.record(record);
      expect(journal.appendedRecordCount).toBe(1);
      await journal.close();

      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
      const content = await readFile(manifestPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      expect(Object.keys(JSON.parse(content.trim()) as object).sort()).toEqual([
        "bucket",
        "key",
        "schemaVersion",
      ]);
      await expect(
        readVideoInputRollbackJournal(manifestPath, CURRENT_BUCKET)
      ).resolves.toEqual([record]);

      const resumed = await openVideoInputRollbackJournal(
        manifestPath,
        CURRENT_BUCKET
      );
      expect(resumed.existingRecordCount).toBe(1);
      expect(resumed.appendedRecordCount).toBe(0);
      await resumed.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("回滚读取拒绝权限放宽或符号链接清单", async () => {
    const directory = await mkdtemp(join(tmpdir(), "video-input-rollback-"));
    const manifestPath = join(directory, "rollback.ndjson");
    const linkPath = join(directory, "rollback-link.ndjson");
    try {
      const journal = await openVideoInputRollbackJournal(
        manifestPath,
        CURRENT_BUCKET
      );
      await journal.record(record);
      await journal.close();
      await chmod(manifestPath, 0o644);
      await expect(
        readVideoInputRollbackJournal(manifestPath, CURRENT_BUCKET)
      ).rejects.toThrow("回滚清单读取失败");

      await chmod(manifestPath, 0o600);
      await symlink(manifestPath, linkPath);
      await expect(
        openVideoInputRollbackJournal(linkPath, CURRENT_BUCKET)
      ).rejects.toThrow("回滚清单初始化失败");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("rollbackVideoInputAssets", () => {
  const firstRecord = {
    schemaVersion: 1,
    bucket: CURRENT_BUCKET,
    key: "user-1/video-inputs/video-1/migration-v1/input-0-0123456789abcdef0123456789abcdef.png",
  } as const;

  it("按对象身份去重并只返回计数，重复回滚由删除适配器幂等收敛", async () => {
    const deleteCalls: string[] = [];
    const dependencies = {
      async deleteStorage(record: VideoInputRollbackRecord) {
        deleteCalls.push(`${record.bucket}\0${record.key}`);
      },
    };

    const first = await rollbackVideoInputAssets(
      [firstRecord, firstRecord],
      dependencies
    );
    const second = await rollbackVideoInputAssets([firstRecord], dependencies);

    expect(first).toEqual({
      status: "rolled_back",
      manifestRecordCount: 2,
      uniqueObjectCount: 1,
      deleteAttemptCount: 1,
    });
    expect(second.deleteAttemptCount).toBe(1);
    expect(deleteCalls).toHaveLength(2);
    expect(JSON.stringify(first)).not.toContain(CURRENT_BUCKET);
    expect(JSON.stringify(first)).not.toContain("video-inputs");
  });

  it("删除失败时停止并保留调用方清单供重跑", async () => {
    const secondRecord = {
      ...firstRecord,
      key: firstRecord.key.replace("input-0", "input-1"),
    };
    const deleted: string[] = [];

    await expect(
      rollbackVideoInputAssets([firstRecord, secondRecord], {
        async deleteStorage(record) {
          if (record.key === secondRecord.key) {
            throw new Error("injected delete failure");
          }
          deleted.push(record.key);
        },
      })
    ).rejects.toThrow("injected delete failure");
    expect(deleted).toEqual([firstRecord.key]);
  });
});
