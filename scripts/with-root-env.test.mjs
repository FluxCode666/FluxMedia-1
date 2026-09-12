import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keys = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "REDIS_HOST",
  "REDIS_PASSWORD",
  "REDIS_DB",
];
const original = {
  DATABASE_URL: "postgresql://original:password@127.0.0.1:5432/fluxmedia",
  BETTER_AUTH_SECRET: "original-secret-$literal-with-#-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
  REDIS_HOST: "127.0.0.1",
  REDIS_PASSWORD: "original-redis-password",
  REDIS_DB: "9",
};

function fixture(t, values = original) {
  const root = mkdtempSync(join(tmpdir(), "fluxmedia-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  copyFileSync(join(repository, "Makefile"), join(root, "Makefile"));
  copyFileSync(
    join(repository, "scripts/with-root-env.mjs"),
    join(root, "scripts/with-root-env.mjs")
  );
  copyFileSync(
    join(repository, "scripts/test-go-integration.mjs"),
    join(root, "scripts/test-go-integration.mjs")
  );
  symlinkSync(
    join(repository, "node_modules"),
    join(root, "node_modules"),
    "dir"
  );
  writeFileSync(
    join(root, ".env"),
    Object.entries(values)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n")
  );
  writeFileSync(
    join(root, "print-env.mjs"),
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k] ?? null]))));`
  );
  const quotedNode = `'${process.execPath.replaceAll("'", "'\\''")}'`;
  // Replace only executables, so actual Make targets and the loader run together.
  // No database, migration, Redis, or real development server is started.
  for (const name of ["go", "pnpm"]) {
    writeFileSync(
      join(root, "bin", name),
      `#!/bin/sh\nexec ${quotedNode} print-env.mjs\n`,
      { mode: 0o755 }
    );
  }
  writeFileSync(join(root, "bin/docker"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return { root, env: { PATH: `${join(root, "bin")}:${process.env.PATH}` } };
}

function invoke(f, command, args, overrides = {}) {
  const result = spawnSync(command, args, {
    cwd: f.root,
    env: { ...f.env, ...overrides },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(
    result.stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith("{"))
  );
}

for (const target of [
  "dev-frontend",
  "dev-backend",
  "dev-migrate",
  "test-go-integration",
]) {
  test(`${target} preserves the configured database, auth secret, and Redis settings`, (t) => {
    const f = fixture(t);
    assert.deepEqual(
      invoke(f, "make", ["--no-print-directory", "-s", target]),
      original
    );
  });
}

test("explicit environment wins over .env.local, which wins over .env", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, ".env.local"),
    "DATABASE_URL=postgresql://local/db\nBETTER_AUTH_SECRET=local-secret\n"
  );
  const result = invoke(f, "make", ["-s", "dev-backend"], {
    DATABASE_URL: "postgresql://explicit/db",
  });
  assert.equal(result.DATABASE_URL, "postgresql://explicit/db");
  assert.equal(result.BETTER_AUTH_SECRET, "local-secret");
  assert.equal(result.REDIS_DB, original.REDIS_DB);
});

test("missing configuration does not silently select a different database or secret", (t) => {
  const f = fixture(t, {});
  const result = invoke(f, "make", ["-s", "dev-backend"]);
  assert.deepEqual(result, Object.fromEntries(keys.map((k) => [k, null])));
});

test("existing Node script invocation remains supported", (t) => {
  const f = fixture(t);
  assert.deepEqual(
    invoke(f, process.execPath, ["scripts/with-root-env.mjs", "print-env.mjs"]),
    original
  );
});

test("direct command failure is propagated", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/with-root-env.mjs",
      "--exec",
      process.execPath,
      "-e",
      "process.exit(23)",
    ],
    {
      cwd: f.root,
      env: f.env,
      encoding: "utf8",
      timeout: 10_000,
    }
  );
  assert.equal(result.status, 23);
});
