/**
 * 统一镜像的启动选版与站内更新切换。
 *
 * 使用方：entrypoint.sh 在启动 supervisor 之前执行本脚本。stdout 只输出白名单
 * KEY=VALUE 行供 entrypoint 导出，日志一律写 stderr。
 *
 * 版本来源有两处：镜像自带的 /app（release.json 描述镜像版本），以及持久卷
 * FLUXMEDIA_RELEASES_DIR 下由 Go 站内更新器解压的版本目录。state.json 记录当前生效版本
 * （active）与待切换版本（pending）。只有 active/pending 记录的基础镜像与当前镜像完全一致
 * 时才使用卷内版本；通过 Deploy Production 换了镜像后一律以镜像为准，卷内旧版本随即清理。
 *
 * 待切换版本的流程：在业务端口上提供维护页 → 用新版本 backend 执行 `--migrate`
 * （Go 迁移在单个事务内执行，失败即整体回滚，此时安全回退到原版本）→ 回填控制台统计
 * 读模型（失败只记警告）→ 写入 active 并清理旧版本目录。
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_DIR_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;
const SAFE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const MAX_PENDING_ATTEMPTS = 3;
const HISTORY_LIMIT = 20;
const MIGRATION_TIMEOUT_MS = 15 * 60_000;
const BACKFILL_TIMEOUT_MS = 20 * 60_000;
const BACKFILL_SCRIPT = "apps/web/scripts/backfill-dashboard-analytics.mjs";

export const EXPORTED_KEYS = Object.freeze([
  "FLUXMEDIA_APP_ROOT",
  "FLUXMEDIA_WEB_ROOT",
  "GO_BACKEND_EXECUTABLE",
  "UNIFIED_SUPERVISOR_PATH",
]);

const stderrLogger = Object.freeze({
  info: (message) => console.error(`[release-boot] ${message}`),
  warn: (message) => console.error(`[release-boot] warning: ${message}`),
});

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 从 release.json 或 state.json 条目中取出版本身份；缺版本号视为无效。 */
function releaseIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const version = typeof value.version === "string" ? value.version : "";
  const gitSha = typeof value.gitSha === "string" ? value.gitSha : "";
  return version ? { version, gitSha } : null;
}

function sameIdentity(left, right) {
  return Boolean(
    left && right && left.version === right.version && left.gitSha === right.gitSha
  );
}

/** 校验卷内版本目录完整可用；目录名只接受版本 tag，避免 state.json 引导路径穿越。 */
async function resolveRelease(releasesDir, entry) {
  if (!entry || typeof entry.dir !== "string" || !RELEASE_DIR_PATTERN.test(entry.dir)) {
    return null;
  }
  const root = join(releasesDir, entry.dir);
  let metadata;
  try {
    metadata = releaseIdentity(await readJson(join(root, "release.json")));
  } catch {
    return null;
  }
  if (!metadata || metadata.version !== entry.version) return null;
  const backend = join(root, "backend");
  try {
    await access(backend, constants.X_OK);
    await access(join(root, "services/unified-runtime/supervisor.mjs"), constants.R_OK);
  } catch {
    return null;
  }
  return { ...metadata, root, backend, dir: entry.dir };
}

/** 镜像版本不输出任何变量，沿用镜像 ENV 默认值。 */
export function releaseExports(release) {
  if (!release.dir) return {};
  const values = {
    FLUXMEDIA_APP_ROOT: release.root,
    FLUXMEDIA_WEB_ROOT: join(release.root, "apps/web"),
    GO_BACKEND_EXECUTABLE: release.backend,
    UNIFIED_SUPERVISOR_PATH: join(release.root, "services/unified-runtime/supervisor.mjs"),
  };
  for (const value of Object.values(values)) {
    if (!SAFE_PATH_PATTERN.test(value)) {
      throw new Error("release path contains unsupported characters");
    }
  }
  return values;
}

function normalizeState(raw) {
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...state,
    schemaVersion: 1,
    active: state.active ?? null,
    pending: state.pending ?? null,
    lastResult: state.lastResult ?? null,
    history: Array.isArray(state.history) ? state.history : [],
  };
}

function recordResult(state, result) {
  state.lastResult = result;
  state.history = [result, ...state.history].slice(0, HISTORY_LIMIT);
}

/** 原子写入 state.json；失败只记日志，由调用方决定是否继续切换。 */
async function persistState(path, state, logger) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    return true;
  } catch (error) {
    logger.warn(`failed to write ${path}: ${error?.message ?? error}`);
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

async function pruneReleases(releasesDir, keep, logger) {
  let entries = [];
  try {
    entries = await readdir(releasesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RELEASE_DIR_PATTERN.test(entry.name)) continue;
    if (keep.has(entry.name)) continue;
    await rm(join(releasesDir, entry.name), { recursive: true, force: true }).catch(
      (error) => logger.warn(`failed to remove release ${entry.name}: ${error?.message}`)
    );
  }
}

function parseBind(bind) {
  const value = bind || ":8080";
  const index = value.lastIndexOf(":");
  const port = Number(value.slice(index + 1));
  if (index < 0 || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("GO_BACKEND_BIND must be host:port or :port");
  }
  const host = value.slice(0, index).replace(/^\[|\]$/g, "");
  return { host: host || undefined, port };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  );
}

function maintenancePage(snapshot) {
  const version = escapeHtml(snapshot.targetVersion ?? "");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>FluxMedia</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b0b0f;color:#e5e7eb}main{text-align:center;padding:24px}p{color:#9ca3af}</style>
</head>
<body>
<main>
<h1>系统正在更新 / Updating</h1>
<p>正在切换到 ${version}，页面会自动刷新。</p>
<p>Switching to ${version}. This page refreshes automatically.</p>
</main>
</body>
</html>
`;
}

/**
 * 在业务端口上提供维护响应：API 返回 503 SYSTEM_UPDATING（与 Go 的错误结构一致），
 * 浏览器页面返回自动刷新的说明页。
 */
export async function startMaintenanceServer({ bind, status }) {
  const { host, port } = parseBind(bind);
  const server = createServer((request, response) => {
    const snapshot = status();
    const path = (request.url ?? "/").split("?")[0];
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Retry-After", "5");
    const wantsPage =
      (request.method === "GET" || request.method === "HEAD") &&
      !path.startsWith("/api/") &&
      String(request.headers.accept ?? "").includes("text/html");
    if (wantsPage) {
      response.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
      response.end(maintenancePage(snapshot));
      return;
    }
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        error: { code: "SYSTEM_UPDATING", message: "System update in progress" },
        update: snapshot,
      })
    );
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      }),
  };
}

/** 运行一个子命令并把它的输出转到 stderr，stdout 保留给 KEY=VALUE 结果。 */
function runCommand(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let child;
    let timedOut = false;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", 2, 2] });
    } catch (error) {
      resolvePromise({ ok: false, reason: error?.message ?? "spawn failed" });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, reason: error?.message ?? "process error" });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ ok: true });
      else if (timedOut) resolvePromise({ ok: false, reason: "timed out" });
      else resolvePromise({ ok: false, reason: signal ? `signal ${signal}` : `exit code ${code}` });
    });
  });
}

function failure(code, message, pending, current, now) {
  return {
    status: "failed",
    code,
    message,
    version: typeof pending?.version === "string" ? pending.version : null,
    fromVersion: current.version,
    finishedAt: now().toISOString(),
  };
}

/**
 * 选出本次启动使用的版本；存在待切换版本时先完成迁移与回填。
 *
 * @returns 生效版本与需要导出给 supervisor 的环境变量。
 * @sideEffects 读写 state.json、清理卷内临时目录与旧版本、临时占用业务端口、执行迁移与回填。
 */
export async function runBoot({
  environment = process.env,
  run = runCommand,
  logger = stderrLogger,
  now = () => new Date(),
  maintenance = startMaintenanceServer,
} = {}) {
  const imageRoot = environment.FLUXMEDIA_IMAGE_ROOT || "/app";
  const releasesDir = environment.FLUXMEDIA_RELEASES_DIR || "/app/releases";
  const statePath = join(releasesDir, "state.json");

  let imageIdentity = null;
  try {
    imageIdentity = releaseIdentity(await readJson(join(imageRoot, "release.json")));
  } catch {
    logger.warn("image release.json is unreadable");
  }
  imageIdentity ??= { version: "0.0.0-dev", gitSha: "" };
  const imageRelease = {
    ...imageIdentity,
    root: imageRoot,
    backend: environment.FLUXMEDIA_IMAGE_BACKEND || "/backend",
    dir: null,
  };
  const result = (release) => ({ release, exports: releaseExports(release) });

  if (!(await isDirectory(releasesDir))) return result(imageRelease);

  // 上一轮下载/解压的残留：此时 backend 尚未启动，不可能有进行中的更新任务。
  for (const name of [".staging", ".downloads"]) {
    await rm(join(releasesDir, name), { recursive: true, force: true }).catch(() => {});
  }

  let raw = null;
  try {
    raw = await readJson(statePath);
  } catch (error) {
    logger.warn(`state.json is unreadable (${error?.message}); using the image release`);
  }
  if (!raw) return result(imageRelease);
  const state = normalizeState(raw);
  let current = imageRelease;

  if (state.active) {
    const release = sameIdentity(state.active.baseImage, imageIdentity)
      ? await resolveRelease(releasesDir, state.active)
      : null;
    if (release) {
      current = release;
    } else {
      logger.info(
        `ignoring release ${state.active.version ?? "unknown"}: the image changed or its files are incomplete`
      );
      state.active = null;
      if (!state.pending) {
        await persistState(statePath, state, logger);
        await pruneReleases(releasesDir, new Set(), logger);
      }
    }
  }

  if (!state.pending) return result(current);

  const pending = state.pending;
  const attempts = Number.isSafeInteger(pending.attempts) ? pending.attempts : 0;
  const target = sameIdentity(pending.baseImage, imageIdentity)
    ? await resolveRelease(releasesDir, pending)
    : null;
  if (!target || attempts >= MAX_PENDING_ATTEMPTS) {
    recordResult(
      state,
      target
        ? failure("too_many_attempts", "Update did not finish after repeated starts", pending, current, now)
        : failure("release_invalid", "Target release does not match this image or is incomplete", pending, current, now)
    );
    state.pending = null;
    await persistState(statePath, state, logger);
    await pruneReleases(releasesDir, new Set([current.dir].filter(Boolean)), logger);
    return result(current);
  }

  state.pending = { ...pending, attempts: attempts + 1 };
  if (!(await persistState(statePath, state, logger))) return result(current);

  const snapshot = { phase: "migrating", targetVersion: target.version };
  let server = null;
  try {
    server = await maintenance({ bind: environment.GO_BACKEND_BIND, status: () => ({ ...snapshot }) });
  } catch (error) {
    logger.warn(`maintenance page unavailable: ${error?.message ?? error}`);
  }

  try {
    const env = {
      ...environment,
      ...releaseExports(target),
      GO_BACKEND_SKIP_MIGRATION: "false",
    };
    logger.info(`migrating database for ${target.version}`);
    const migration = await run(target.backend, ["--migrate"], {
      cwd: target.root,
      env,
      timeoutMs: MIGRATION_TIMEOUT_MS,
    });
    if (!migration.ok) {
      logger.warn(`migration for ${target.version} failed (${migration.reason}); staying on ${current.version}`);
      recordResult(
        state,
        failure("migration_failed", `Database migration failed: ${migration.reason}`, pending, current, now)
      );
      state.pending = null;
      await persistState(statePath, state, logger);
      await pruneReleases(releasesDir, new Set([current.dir].filter(Boolean)), logger);
      return result(current);
    }

    const warnings = [];
    const backfillScript = join(target.root, BACKFILL_SCRIPT);
    if (await access(backfillScript, constants.R_OK).then(() => true, () => false)) {
      snapshot.phase = "backfilling";
      const backfill = await run(
        environment.UNIFIED_NODE_EXECUTABLE || process.execPath,
        [backfillScript, "--batch-size=500", "--skip-ready"],
        { cwd: target.root, env, timeoutMs: BACKFILL_TIMEOUT_MS }
      );
      if (!backfill.ok) {
        logger.warn(`dashboard analytics backfill failed (${backfill.reason})`);
        warnings.push("dashboard_backfill_failed");
      }
    }

    const { attempts: _attempts, previous: _previous, ...activeEntry } = state.pending;
    state.active = {
      ...activeEntry,
      version: target.version,
      gitSha: target.gitSha,
      dir: target.dir,
      activatedAt: now().toISOString(),
    };
    state.pending = null;
    recordResult(state, {
      status: "succeeded",
      code: "succeeded",
      message: null,
      version: target.version,
      fromVersion: current.version,
      warnings,
      finishedAt: now().toISOString(),
    });
    if (!(await persistState(statePath, state, logger))) {
      // 迁移已提交；即使状态没写成功，也只能继续使用新版本代码启动。
      logger.warn("could not record the activated release; it will be re-validated on next start");
    }
    await pruneReleases(releasesDir, new Set([target.dir, current.dir].filter(Boolean)), logger);
    logger.info(`switched from ${current.version} to ${target.version}`);
    return result(target);
  } finally {
    await server?.close();
  }
}

async function main() {
  const { exports } = await runBoot();
  for (const key of EXPORTED_KEYS) {
    if (exports[key]) process.stdout.write(`${key}=${exports[key]}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(`[release-boot] failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
