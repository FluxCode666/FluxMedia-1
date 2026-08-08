/**
 * FluxMedia PostgreSQL 生产迁移入口。
 *
 * 职责：加载 monorepo 根环境、固定迁移会话为 UTC、通过 Drizzle ORM 按 journal
 * 顺序执行事务迁移，并在失败时输出脱敏的完整 cause 链。
 * 使用方：`pnpm --filter @repo/database db:migrate`、Docker migrator 与 CI。
 * 关键依赖：DATABASE_URL、drizzle-orm/node-postgres、pg 与 drizzle 目录。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { describeMigrationErrorChain } from "./migration-error.mjs";

const { Pool } = pg;
const databasePackageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  ".."
);
const projectRoot = resolve(databasePackageRoot, "../..");
const migrationsFolder = resolve(databasePackageRoot, "drizzle");

/**
 * 按本地优先级加载根环境文件；部署容器已注入的变量不会被覆盖。
 *
 * @returns 环境加载完成后返回。
 * @sideEffect 仅补充当前 Node 进程的 process.env。
 */
function loadProjectEnvironment() {
  dotenv.config({ path: resolve(projectRoot, ".env.local") });
  dotenv.config({ path: resolve(projectRoot, ".env") });
}

/**
 * 读取数据库连接 URL，并在缺失时显式阻断迁移。
 *
 * @returns 非空 DATABASE_URL。
 * @throws 环境未配置 DATABASE_URL 时抛出，不尝试建立连接。
 * @sideEffect 无副作用。
 */
function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 环境变量未设置，数据库迁移已终止");
  }
  return databaseUrl;
}

/**
 * 执行所有尚未登记的 Drizzle 迁移，并确保连接池在成功或失败时关闭。
 *
 * @returns 迁移成功后返回；失败时设置非零退出码。
 * @sideEffect 可能在目标 PostgreSQL 内提交 journal 中尚未执行的事务迁移。
 */
async function runDatabaseMigrations() {
  loadProjectEnvironment();

  let pool;
  try {
    pool = new Pool({
      application_name: "fluxmedia-database-migrator",
      connectionString: requireDatabaseUrl(),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      max: 1,
      options: "-c timezone=UTC",
    });
    const database = drizzle(pool);
    await migrate(database, { migrationsFolder });
    console.log("database_migration_completed=true");
  } catch (error) {
    console.error(
      `database_migration_error=${JSON.stringify(
        describeMigrationErrorChain(error)
      )}`
    );
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        console.error(
          `database_migration_pool_close_error=${JSON.stringify(
            describeMigrationErrorChain(error)
          )}`
        );
        process.exitCode = 1;
      }
    }
  }
}

await runDatabaseMigrations();
