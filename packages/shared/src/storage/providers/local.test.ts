/**
 * 本地存储 resolveSafePath 路径穿越守卫的 DB-free 单测
 *
 * resolveSafePath 是 local 存储 deleteObject/getObject/putObject 的唯一目录
 * 穿越防线。这里注入 node:path 的 posix 变体，使断言不依赖宿主操作系统的
 * 分隔符，并独立于运行时设置（baseDir 由入参注入）。
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// local.ts 在模块层 import ../../system-settings，其真实实现会 import
// @repo/database 并要求 DATABASE_URL。这里 mock 掉以保持 DB-free。
vi.mock("../../system-settings", () => ({
  getRuntimeSettingString: vi.fn(async () => null),
}));

import { verifySignedImageUrl } from "../signed-url";
import {
  createLocalStorageProvider,
  localProvider,
  resolveSafePath,
} from "./local";

// 统一用 posix 语义，避免 Windows 反斜杠分隔符影响断言。
const posix = path.posix;
const BASE = "/data/storage";
const TEST_SECRET = "test-secret-for-local-provider";

const originalSecret = process.env.BETTER_AUTH_SECRET;

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.BETTER_AUTH_SECRET;
  } else {
    process.env.BETTER_AUTH_SECRET = originalSecret;
  }
});

describe("resolveSafePath", () => {
  it("正常 key 返回 join(base, bucket, key)", () => {
    expect(resolveSafePath(posix, BASE, "avatars", "user-1-1.png")).toBe(
      "/data/storage/avatars/user-1-1.png"
    );
  });

  it("支持多级 key 而不逃逸 base", () => {
    expect(resolveSafePath(posix, BASE, "generations", "user-1/img.png")).toBe(
      "/data/storage/generations/user-1/img.png"
    );
  });

  it("key 含 '..' 抛错", () => {
    expect(() =>
      resolveSafePath(posix, BASE, "avatars", "../secret.png")
    ).toThrow(/directory traversal/);
  });

  it("bucket 含 '..' 抛错", () => {
    expect(() => resolveSafePath(posix, BASE, "..", "user-1-1.png")).toThrow(
      /directory traversal/
    );
  });

  it("含前导斜杠的 key 经 join 仍被并入 base，不发生逃逸", () => {
    // path.join 把所有段视为相对片段拼接，绝对 key 不会跳出 base；
    // 真正的逃逸须借助 ".."，已在上面用例覆盖。
    expect(resolveSafePath(posix, BASE, "avatars", "/etc/passwd")).toBe(
      "/data/storage/avatars/etc/passwd"
    );
  });

  it("前缀混淆不接受 sibling 目录（验证 startsWith 带 path.sep）", () => {
    // base='/data/gen' 时不得把 '/data/gen-evil/x' 误判为 base 内。
    // 用 '..' 跳到 sibling 触发逃逸判定。
    expect(() =>
      resolveSafePath(posix, "/data/gen", "bucket", "../../gen-evil/x")
    ).toThrow(/directory traversal/);
  });

  it("解析后恰为 base/bucket 自身（无 key 段）不误判逃逸", () => {
    expect(resolveSafePath(posix, BASE, "avatars", ".")).toBe(
      "/data/storage/avatars"
    );
  });
});

describe("localProvider.getSignedUrl", () => {
  it("returns a signed read URL for non-public buckets", async () => {
    const url = await localProvider.getSignedUrl(
      "user-1/out.png",
      "generations",
      60
    );
    const parsed = new URL(url, "https://app.example.test");
    const sig = parsed.searchParams.get("sig");
    const exp = Number(parsed.searchParams.get("exp"));

    expect(parsed.pathname).toBe("/api/storage/generations/user-1/out.png");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    if (!sig) throw new Error("missing signature");
    expect(
      verifySignedImageUrl("generations", "user-1/out.png", sig, exp)
    ).toBe("valid");
  });

  it("returns a signed URL for the actual runtime system bucket", async () => {
    const url = await localProvider.getSignedUrl(
      "user-1/avatar.png",
      "avatars",
      60
    );
    const parsed = new URL(url, "https://app.example.test");
    const sig = parsed.searchParams.get("sig");
    const exp = Number(parsed.searchParams.get("exp"));

    expect(parsed.pathname).toBe("/api/storage/avatars/user-1/avatar.png");
    expect(sig).toMatch(/^[a-f0-9]{64}$/);
    expect(exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    if (!sig) throw new Error("missing signature");
    expect(verifySignedImageUrl("avatars", "user-1/avatar.png", sig, exp)).toBe(
      "valid"
    );
  });
});

describe("localProvider streaming", () => {
  it("以临时文件原子写入并可逐块读取", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const tempDir = await fs.mkdtemp(`${os.tmpdir()}/flux-storage-stream-`);
    try {
      const provider = createLocalStorageProvider(tempDir);
      async function* bytes() {
        yield Buffer.from("第一段");
        yield Buffer.from("-第二段");
      }
      if (!provider.putObjectStream || !provider.getObjectStream) {
        throw new Error("local provider streaming missing");
      }
      await provider.putObjectStream(
        "exports/test.csv",
        "private",
        bytes(),
        "text/csv"
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of await provider.getObjectStream(
        "exports/test.csv",
        "private"
      )) {
        chunks.push(chunk);
      }
      expect(Buffer.concat(chunks).toString("utf8")).toBe("第一段-第二段");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("取消流式写入后不留下目标或临时对象", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = await fs.mkdtemp(`${os.tmpdir()}/flux-storage-abort-`);
    try {
      const provider = createLocalStorageProvider(tempDir);
      const controller = new AbortController();
      if (!provider.putObjectStream) {
        throw new Error("local provider streaming missing");
      }
      async function* bytes() {
        yield Buffer.from("第一段");
        controller.abort();
        yield Buffer.from("不应写入");
      }
      await expect(
        provider.putObjectStream(
          "exports/test.csv",
          "private",
          bytes(),
          "text/csv",
          { signal: controller.signal }
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      const exportDir = path.join(tempDir, "private", "exports");
      const entries = await fs.readdir(exportDir).catch(() => []);
      expect(entries).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("取消流式写入时保留调用前已经存在的目标对象", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = await fs.mkdtemp(`${os.tmpdir()}/flux-storage-existing-`);
    try {
      const provider = createLocalStorageProvider(tempDir);
      const controller = new AbortController();
      const objectPath = path.join(
        tempDir,
        "private",
        "exports",
        "test.csv"
      );
      await fs.mkdir(path.dirname(objectPath), { recursive: true });
      await fs.writeFile(objectPath, "既有对象");
      controller.abort();
      if (!provider.putObjectStream) {
        throw new Error("local provider streaming missing");
      }

      /** 提供不会在已取消请求中被消费的测试字节流。 */
      async function* bytes() {
        yield Buffer.from("不应覆盖");
      }

      await expect(
        provider.putObjectStream(
          "exports/test.csv",
          "private",
          bytes(),
          "text/csv",
          { signal: controller.signal }
        )
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(fs.readFile(objectPath, "utf8")).resolves.toBe("既有对象");
      await expect(fs.readdir(path.dirname(objectPath))).resolves.toEqual([
        "test.csv",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("按前缀分页枚举完成对象与陈旧临时文件", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = await fs.mkdtemp(`${os.tmpdir()}/flux-storage-list-`);
    try {
      const provider = createLocalStorageProvider(tempDir);
      const exportDir = path.join(
        tempDir,
        "private",
        "operations-exports",
        "task-1"
      );
      await fs.mkdir(exportDir, { recursive: true });
      const completedPath = path.join(exportDir, "lease-1.csv");
      const tempPath = path.join(exportDir, "lease-2.csv.random.tmp");
      await fs.writeFile(completedPath, "completed");
      await fs.writeFile(tempPath, "partial");
      const staleAt = new Date("2026-02-01T00:00:00.000Z");
      await fs.utimes(completedPath, staleAt, staleAt);
      await fs.utimes(tempPath, staleAt, staleAt);

      if (!provider.listObjects) throw new Error("local listing missing");
      const first = await provider.listObjects(
        "operations-exports",
        "private",
        { limit: 1 }
      );
      const second = await provider.listObjects(
        "operations-exports",
        "private",
        { cursor: first.nextCursor, limit: 1 }
      );

      expect([...first.objects, ...second.objects]).toEqual([
        {
          key: "operations-exports/task-1/lease-1.csv",
          lastModified: staleAt,
        },
        {
          key: "operations-exports/task-1/lease-2.csv.random.tmp",
          lastModified: staleAt,
        },
      ]);
      await provider.deleteObject(
        "operations-exports/task-1/lease-2.csv.random.tmp",
        "private"
      );
      await expect(fs.access(tempPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("拒绝沿 bucket 符号链接扫描存储根目录之外", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tempDir = await fs.mkdtemp(`${os.tmpdir()}/flux-storage-root-`);
    const externalDir = await fs.mkdtemp(
      `${os.tmpdir()}/flux-storage-external-`
    );
    try {
      const externalExportDir = path.join(
        externalDir,
        "operations-exports",
        "task-1"
      );
      await fs.mkdir(externalExportDir, { recursive: true });
      await fs.writeFile(path.join(externalExportDir, "lease-1.csv"), "data");
      await fs.symlink(externalDir, path.join(tempDir, "private"), "dir");
      const provider = createLocalStorageProvider(tempDir);
      if (!provider.listObjects) throw new Error("local listing missing");

      await expect(
        provider.listObjects("operations-exports", "private", { limit: 10 })
      ).rejects.toThrow("symbolic link");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });
});
