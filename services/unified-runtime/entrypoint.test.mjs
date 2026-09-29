import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const entrypoint = new URL("./entrypoint.sh", import.meta.url);

test("entrypoint executes an explicit command unchanged", async () => {
  const { stdout } = await execFileAsync("sh", [
    entrypoint.pathname,
    "/bin/echo",
    "release-gate",
  ]);
  assert.equal(stdout.trim(), "release-gate");
});

test("entrypoint strips raw dotenv quotes without changing dollar signs", async () => {
  const { stdout } = await execFileAsync(
    "sh",
    [
      entrypoint.pathname,
      "/bin/sh",
      "-c",
      "printf '%s\\n' \"$DATABASE_URL\" \"$REDIS_PASSWORD\" \"$FLUXMEDIA_SUPER_ADMIN_PASSWORD\" \"$GO_SCRIPT_RUNTIME_TOKEN\" \"$GO_MEDIA_PROCESSING_TOKEN\"",
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: '"postgresql://user:p$literal@db/flux"',
        REDIS_PASSWORD: '"redis$literal"',
        GO_SCRIPT_RUNTIME_TOKEN: '"script$literal"',
        GO_MEDIA_PROCESSING_TOKEN: '"media$literal"',
        FLUXMEDIA_SUPER_ADMIN_PASSWORD: '"admin$literal"',
      },
    }
  );
  assert.equal(
    stdout,
    "postgresql://user:p$literal@db/flux\nredis$literal\nadmin$literal\nscript$literal\nmedia$literal\n"
  );
});

test("entrypoint starts the Node supervisor when no command is supplied", async () => {
  const { stdout } = await execFileAsync("sh", [entrypoint.pathname], {
    env: {
      ...process.env,
      UNIFIED_NODE_EXECUTABLE: "/bin/echo",
      UNIFIED_SUPERVISOR_PATH: "/app/test-supervisor.mjs",
    },
  });
  assert.equal(stdout.trim(), "/app/test-supervisor.mjs");
});

test("entrypoint exports only allowlisted release paths chosen at boot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluxmedia-entrypoint-"));
  try {
    const boot = join(directory, "boot.sh");
    const supervisor = join(directory, "supervisor.sh");
    await writeFile(
      boot,
      [
        "printf '%s\\n' 'FLUXMEDIA_APP_ROOT=/app/releases/v1.2.3'",
        `printf '%s\\n' 'UNIFIED_SUPERVISOR_PATH=${supervisor}'`,
        "printf '%s\\n' 'DATABASE_URL=postgresql://attacker/db'",
        "printf '%s\\n' 'not a pair'",
      ].join("\n")
    );
    await writeFile(
      supervisor,
      "printf '%s|%s\\n' \"$FLUXMEDIA_APP_ROOT\" \"$DATABASE_URL\"\n"
    );
    const { stdout } = await execFileAsync("sh", [entrypoint.pathname], {
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user@db/flux",
        UNIFIED_BOOT_PATH: boot,
        UNIFIED_NODE_EXECUTABLE: "/bin/sh",
      },
    });
    assert.equal(stdout, "/app/releases/v1.2.3|postgresql://user@db/flux\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("entrypoint refuses to start when release selection fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluxmedia-entrypoint-"));
  try {
    const boot = join(directory, "boot.sh");
    await writeFile(boot, "exit 3\n");
    await assert.rejects(
      execFileAsync("sh", [entrypoint.pathname], {
        env: {
          ...process.env,
          UNIFIED_BOOT_PATH: boot,
          UNIFIED_NODE_EXECUTABLE: "/bin/sh",
          UNIFIED_SUPERVISOR_PATH: "/bin/true",
        },
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
