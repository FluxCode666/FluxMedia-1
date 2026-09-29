import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runBoot } from "./boot.mjs";

const image = { version: "v1.0.0", gitSha: "a".repeat(40) };
const silent = { info() {}, warn() {} };
const fixedNow = () => new Date("2026-09-30T00:00:00.000Z");

async function makeRelease(root, version, gitSha = "b".repeat(40)) {
  await mkdir(join(root, "services/unified-runtime"), { recursive: true });
  await mkdir(join(root, "apps/web/scripts"), { recursive: true });
  await writeFile(join(root, "release.json"), JSON.stringify({ version, gitSha }));
  await writeFile(join(root, "services/unified-runtime/supervisor.mjs"), "");
  await writeFile(join(root, "apps/web/scripts/backfill-dashboard-analytics.mjs"), "");
  await writeFile(join(root, "backend"), "#!/bin/sh\n");
  await chmod(join(root, "backend"), 0o755);
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fluxmedia-boot-"));
  const imageRoot = join(directory, "image");
  const releasesDir = join(directory, "releases");
  await mkdir(imageRoot, { recursive: true });
  await mkdir(releasesDir, { recursive: true });
  await writeFile(join(imageRoot, "release.json"), JSON.stringify(image));
  return {
    directory,
    releasesDir,
    environment: {
      FLUXMEDIA_IMAGE_ROOT: imageRoot,
      FLUXMEDIA_RELEASES_DIR: releasesDir,
      FLUXMEDIA_IMAGE_BACKEND: "/backend",
      GO_BACKEND_BIND: "127.0.0.1:0",
      UNIFIED_NODE_EXECUTABLE: "/usr/bin/node",
      DATABASE_URL: "postgresql://db/flux",
    },
    writeState: (state) =>
      writeFile(join(releasesDir, "state.json"), JSON.stringify(state)),
    readState: async () =>
      JSON.parse(await readFile(join(releasesDir, "state.json"), "utf8")),
    exists: (name) =>
      stat(join(releasesDir, name)).then(
        () => true,
        () => false
      ),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

const noMaintenance = async () => ({ close: async () => {} });

test("uses the image release when there is no releases volume", async () => {
  const context = await fixture();
  try {
    await rm(context.releasesDir, { recursive: true });
    const { release, exports } = await runBoot({
      environment: context.environment,
      logger: silent,
    });
    assert.equal(release.version, "v1.0.0");
    assert.deepEqual(exports, {});
  } finally {
    await context.cleanup();
  }
});

test("uses the active volume release built on the running image", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.1.0"), "v1.1.0");
    await mkdir(join(context.releasesDir, ".staging/leftover"), { recursive: true });
    await context.writeState({
      active: { version: "v1.1.0", gitSha: "b".repeat(40), dir: "v1.1.0", baseImage: image },
    });
    const { release, exports } = await runBoot({
      environment: context.environment,
      logger: silent,
    });
    const root = join(context.releasesDir, "v1.1.0");
    assert.equal(release.version, "v1.1.0");
    assert.deepEqual(exports, {
      FLUXMEDIA_APP_ROOT: root,
      FLUXMEDIA_WEB_ROOT: join(root, "apps/web"),
      GO_BACKEND_EXECUTABLE: join(root, "backend"),
      UNIFIED_SUPERVISOR_PATH: join(root, "services/unified-runtime/supervisor.mjs"),
    });
    assert.equal(await context.exists(".staging"), false);
  } finally {
    await context.cleanup();
  }
});

test("a newly deployed image wins over releases staged for an older image", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.1.0"), "v1.1.0");
    await context.writeState({
      active: {
        version: "v1.1.0",
        gitSha: "b".repeat(40),
        dir: "v1.1.0",
        baseImage: { version: "v0.9.0", gitSha: "c".repeat(40) },
      },
    });
    const { release, exports } = await runBoot({
      environment: context.environment,
      logger: silent,
    });
    assert.equal(release.version, "v1.0.0");
    assert.deepEqual(exports, {});
    assert.equal((await context.readState()).active, null);
    assert.equal(await context.exists("v1.1.0"), false);
  } finally {
    await context.cleanup();
  }
});

test("rejects release directories that could escape the volume", async () => {
  const context = await fixture();
  try {
    await context.writeState({
      active: { version: "v1.1.0", gitSha: "", dir: "../image", baseImage: image },
    });
    const { release } = await runBoot({ environment: context.environment, logger: silent });
    assert.equal(release.version, "v1.0.0");
  } finally {
    await context.cleanup();
  }
});

test("migrates a pending release behind the maintenance page and activates it", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.1.0"), "v1.1.0");
    await makeRelease(join(context.releasesDir, "v1.2.0"), "v1.2.0", "d".repeat(40));
    await makeRelease(join(context.releasesDir, "v0.9.0"), "v0.9.0");
    await context.writeState({
      active: { version: "v1.1.0", gitSha: "b".repeat(40), dir: "v1.1.0", baseImage: image },
      pending: {
        version: "v1.2.0",
        gitSha: "d".repeat(40),
        dir: "v1.2.0",
        baseImage: image,
        previous: { version: "v1.1.0" },
        backup: "backups/before-v1.2.0.dump",
      },
    });
    const commands = [];
    let maintenanceResponse;
    let maintenancePort;
    const { release, exports } = await runBoot({
      environment: context.environment,
      logger: silent,
      now: fixedNow,
      async run(command, args, options) {
        commands.push({ command, args, options });
        if (args[0] === "--migrate") {
          const state = await context.readState();
          assert.equal(state.pending.attempts, 1);
          const response = await fetch(`http://127.0.0.1:${maintenancePort}/api/admin/system-update`);
          maintenanceResponse = { status: response.status, body: await response.json() };
        }
        return { ok: true };
      },
      async maintenance(options) {
        const { startMaintenanceServer } = await import("./boot.mjs");
        const server = await startMaintenanceServer(options);
        maintenancePort = server.port;
        return server;
      },
    });

    const target = join(context.releasesDir, "v1.2.0");
    assert.equal(release.version, "v1.2.0");
    assert.equal(exports.FLUXMEDIA_APP_ROOT, target);
    assert.equal(commands[0].command, join(target, "backend"));
    assert.deepEqual(commands[0].args, ["--migrate"]);
    assert.equal(commands[0].options.cwd, target);
    assert.equal(commands[0].options.env.GO_BACKEND_SKIP_MIGRATION, "false");
    assert.equal(commands[0].options.env.FLUXMEDIA_APP_ROOT, target);
    assert.equal(commands[0].options.env.DATABASE_URL, "postgresql://db/flux");
    assert.equal(commands[1].command, "/usr/bin/node");
    assert.deepEqual(commands[1].args.slice(1), ["--batch-size=500", "--skip-ready"]);
    assert.deepEqual(maintenanceResponse, {
      status: 503,
      body: {
        error: { code: "SYSTEM_UPDATING", message: "System update in progress" },
        update: { phase: "migrating", targetVersion: "v1.2.0" },
      },
    });

    const state = await context.readState();
    assert.equal(state.pending, null);
    assert.equal(state.active.version, "v1.2.0");
    assert.equal(state.active.dir, "v1.2.0");
    assert.equal(state.active.backup, "backups/before-v1.2.0.dump");
    assert.equal(state.active.previous, undefined);
    assert.equal(state.active.attempts, undefined);
    assert.equal(state.lastResult.status, "succeeded");
    assert.equal(state.lastResult.fromVersion, "v1.1.0");
    assert.deepEqual(state.lastResult.warnings, []);
    assert.equal(state.history.length, 1);
    assert.equal(await context.exists("v1.1.0"), true);
    assert.equal(await context.exists("v0.9.0"), false);
  } finally {
    await context.cleanup();
  }
});

test("stays on the current release when the migration fails", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.2.0"), "v1.2.0");
    await context.writeState({
      pending: { version: "v1.2.0", gitSha: "b".repeat(40), dir: "v1.2.0", baseImage: image },
    });
    const { release, exports } = await runBoot({
      environment: context.environment,
      logger: silent,
      now: fixedNow,
      maintenance: noMaintenance,
      run: async () => ({ ok: false, reason: "exit code 1" }),
    });
    assert.equal(release.version, "v1.0.0");
    assert.deepEqual(exports, {});
    const state = await context.readState();
    assert.equal(state.pending, null);
    assert.equal(state.active, null);
    assert.equal(state.lastResult.status, "failed");
    assert.equal(state.lastResult.code, "migration_failed");
    assert.equal(state.lastResult.version, "v1.2.0");
    assert.equal(await context.exists("v1.2.0"), false);
  } finally {
    await context.cleanup();
  }
});

test("records a warning but still switches when the backfill fails", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.2.0"), "v1.2.0");
    await context.writeState({
      pending: { version: "v1.2.0", gitSha: "b".repeat(40), dir: "v1.2.0", baseImage: image },
    });
    const { release } = await runBoot({
      environment: context.environment,
      logger: silent,
      maintenance: noMaintenance,
      run: async (_command, args) => ({ ok: args[0] === "--migrate", reason: "exit code 2" }),
    });
    assert.equal(release.version, "v1.2.0");
    const state = await context.readState();
    assert.equal(state.lastResult.status, "succeeded");
    assert.deepEqual(state.lastResult.warnings, ["dashboard_backfill_failed"]);
  } finally {
    await context.cleanup();
  }
});

test("gives up on a pending release after repeated interrupted starts", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.2.0"), "v1.2.0");
    await context.writeState({
      pending: {
        version: "v1.2.0",
        gitSha: "b".repeat(40),
        dir: "v1.2.0",
        baseImage: image,
        attempts: 3,
      },
    });
    const { release } = await runBoot({
      environment: context.environment,
      logger: silent,
      maintenance: noMaintenance,
      run: async () => assert.fail("must not migrate"),
    });
    assert.equal(release.version, "v1.0.0");
    const state = await context.readState();
    assert.equal(state.pending, null);
    assert.equal(state.lastResult.code, "too_many_attempts");
  } finally {
    await context.cleanup();
  }
});

test("discards a pending release staged for a different image", async () => {
  const context = await fixture();
  try {
    await makeRelease(join(context.releasesDir, "v1.2.0"), "v1.2.0");
    await context.writeState({
      pending: {
        version: "v1.2.0",
        gitSha: "b".repeat(40),
        dir: "v1.2.0",
        baseImage: { version: "v0.9.0", gitSha: "" },
      },
    });
    const { release } = await runBoot({
      environment: context.environment,
      logger: silent,
      maintenance: noMaintenance,
      run: async () => assert.fail("must not migrate"),
    });
    assert.equal(release.version, "v1.0.0");
    const state = await context.readState();
    assert.equal(state.lastResult.code, "release_invalid");
    assert.equal(await context.exists("v1.2.0"), false);
  } finally {
    await context.cleanup();
  }
});
