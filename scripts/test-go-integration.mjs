// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: standalone Make target; never run through Turbo caching.
/** Run Go integration tests against a dedicated database in the local container. */
import { spawnSync } from "node:child_process";

const container = "fluxcode-local-postgres";
const inheritedURL = process.env.DATABASE_URL;
if (!inheritedURL) throw new Error("DATABASE_URL is required");
const databaseURL = new URL(
  process.env.GO_BACKEND_TEST_DATABASE_URL || inheritedURL
);
if (!process.env.GO_BACKEND_TEST_DATABASE_URL)
  databaseURL.pathname = "/fluxmedia_go_test_local";
const database = databaseURL.pathname.slice(1);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(databaseURL.hostname) ||
  !/^fluxmedia_go_test_[a-z0-9_]+$/.test(database)
) {
  throw new Error(
    "Go integration tests require a local fluxmedia_go_test_* database"
  );
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed while preparing Go integration tests`);
  return result.stdout?.trim();
}
const admin = process.env.GO_TEST_POSTGRES_ADMIN || "fluxcode";
const exists = run("docker", [
  "exec",
  container,
  "psql",
  "-U",
  admin,
  "-d",
  "postgres",
  "-Atc",
  `SELECT 1 FROM pg_database WHERE datname='${database}'`,
]);
if (exists !== "1")
  run("docker", [
    "exec",
    container,
    "createdb",
    "-U",
    admin,
    "-O",
    decodeURIComponent(databaseURL.username),
    database,
  ]);
const result = spawnSync(
  "go",
  ["-C", "services/api-gateway", "test", "-race", "-tags=integration", "./..."],
  {
    env: {
      ...process.env,
      GO_BACKEND_TEST_DATABASE_URL: databaseURL.toString(),
      REDIS_ADDR: `${process.env.REDIS_HOST}:${process.env.REDIS_PORT || "6379"}`,
    },
    stdio: "inherit",
  }
);
if (result.error) console.error("Unable to start Go integration tests");
process.exitCode = result.status ?? 1;
