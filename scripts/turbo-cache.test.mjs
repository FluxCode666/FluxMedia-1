/**
 * Turbo 缓存容量守卫的 DB-free Node 单元测试。
 *
 * 使用方：根目录 `pnpm test`。测试仅操作系统临时目录，覆盖未超限、严格
 * 阈值、超限、显式清理和活动进程失败保护。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isTurboCacheWriter,
  isTurboCommand,
  maintainTurboCache,
  parseMaxCacheBytes,
} from "./turbo-cache.mjs";

/**
 * 创建带一个指定大小文件的临时缓存仓库。
 *
 * @param {number} sizeBytes 缓存文件大小。
 * @returns {Promise<{ cachePath: string; projectRoot: string }>} 临时路径。
 */
async function createTemporaryCache(sizeBytes) {
  const targetRoot = await mkdtemp(join(tmpdir(), "fluxmedia-turbo-cache-"));
  const cachePath = join(targetRoot, ".turbo", "cache");
  await mkdir(cachePath, { recursive: true });
  await writeFile(join(cachePath, "artifact.bin"), Buffer.alloc(sizeBytes));
  return { cachePath, projectRoot: targetRoot };
}

/**
 * 返回测试缓存文件大小，目录已清理时返回 null。
 *
 * @param {string} cachePath 临时缓存目录。
 * @returns {Promise<number | null>} 文件字节数或 null。
 */
async function readCacheSize(cachePath) {
  try {
    return (await readFile(join(cachePath, "artifact.bin"))).byteLength;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

/** 模拟没有 Turbo 进程。 */
async function reportTurboIdle() {
  return false;
}

/** 模拟存在活动 Turbo 进程。 */
async function reportTurboRunning() {
  return true;
}

/**
 * 运行一次临时缓存场景并保证清理测试目录。
 *
 * @param {number} sizeBytes 缓存文件大小。
 * @param {"clean" | "trim"} action 维护动作。
 * @param {number} maxBytes trim 阈值。
 * @returns {Promise<{ cacheSize: number | null; status: string }>} 场景结果。
 */
async function runCacheScenario(sizeBytes, action, maxBytes) {
  const temporary = await createTemporaryCache(sizeBytes);
  try {
    const result = await maintainTurboCache({
      action,
      isTurboRunning: reportTurboIdle,
      maxBytes,
      projectRoot: temporary.projectRoot,
    });
    return {
      cacheSize: await readCacheSize(temporary.cachePath),
      status: result.status,
    };
  } finally {
    await rm(temporary.projectRoot, { force: true, recursive: true });
  }
}

/** 验证未超限缓存保持不变。 */
async function retainsBelowLimit() {
  assert.deepEqual(await runCacheScenario(4, "trim", 5), {
    cacheSize: 4,
    status: "retained",
  });
}

/** 验证刚好等于阈值时保持不变。 */
async function retainsAtExactLimit() {
  assert.deepEqual(await runCacheScenario(5, "trim", 5), {
    cacheSize: 5,
    status: "retained",
  });
}

/** 验证超过阈值时删除缓存。 */
async function removesAboveLimit() {
  assert.deepEqual(await runCacheScenario(6, "trim", 5), {
    cacheSize: null,
    status: "cleaned",
  });
}

/** 验证 clean 不受容量阈值限制。 */
async function alwaysRunsExplicitClean() {
  assert.deepEqual(await runCacheScenario(1, "clean", 5), {
    cacheSize: null,
    status: "cleaned",
  });
}

/** 验证活动 Turbo 使清理失败且缓存保留。 */
async function refusesWhileTurboRuns() {
  const temporary = await createTemporaryCache(6);
  try {
    await assert.rejects(
      maintainTurboCache({
        action: "clean",
        isTurboRunning: reportTurboRunning,
        projectRoot: temporary.projectRoot,
      }),
      /正在读写缓存的 Turbo 任务/u
    );
    assert.equal(await readCacheSize(temporary.cachePath), 6);
  } finally {
    await rm(temporary.projectRoot, { force: true, recursive: true });
  }
}

/** 验证进程识别不会把维护脚本误判成 Turbo CLI。 */
function identifiesTurboExecutableOnly() {
  assert.equal(
    isTurboCommand("/repo/node_modules/turbo/bin/turbo build"),
    true
  );
  assert.equal(
    isTurboCommand("node /repo/scripts/turbo-cache.mjs trim"),
    false
  );
  assert.equal(
    isTurboCommand("/bin/sh -c pnpm cache:trim && turbo lint"),
    false
  );
  assert.equal(isTurboCacheWriter("/repo/bin/turbo dev"), false);
  assert.equal(isTurboCacheWriter("/repo/bin/turbo run dev"), false);
  assert.equal(isTurboCacheWriter("/repo/bin/turbo build"), true);
  assert.equal(
    isTurboCacheWriter("/bin/sh -c pnpm cache:trim && turbo lint"),
    false
  );
  assert.equal(parseMaxCacheBytes(undefined), 20 * 1024 ** 3);
  assert.equal(parseMaxCacheBytes("0.5"), 512 * 1024 ** 2);
  assert.throws(() => parseMaxCacheBytes("0"), /大于 0/u);
}

test("未超限时保留 Turbo 缓存", retainsBelowLimit);
test("等于阈值时保留 Turbo 缓存", retainsAtExactLimit);
test("超过阈值时删除 Turbo 缓存", removesAboveLimit);
test("显式 clean 始终删除缓存", alwaysRunsExplicitClean);
test("Turbo 运行时拒绝清理", refusesWhileTurboRuns);
test("只识别 Turbo 可执行文件", identifiesTurboExecutableOnly);
