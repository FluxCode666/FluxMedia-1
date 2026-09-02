/** Leonardo 图片尺寸配置迁移的静态契约。 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const databasePackageRoot = resolve(scriptsDirectory, "..");
const migrationPath = resolve(
  databasePackageRoot,
  "drizzle/0104_seed_leonardo_image_size_config.sql"
);
const journalPath = resolve(databasePackageRoot, "drizzle/meta/_journal.json");

test("0104 幂等写入 Leonardo 的 1K 图片尺寸映射并登记 journal", async () => {
  const [migrationSql, journalText] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(journalPath, "utf8"),
  ]);
  const journal = JSON.parse(journalText);

  assert.ok(
    journal.entries.some(
      (entry) => entry.tag === "0104_seed_leonardo_image_size_config"
    )
  );
  assert.match(
    migrationSql,
    /VALUES \('system-image-size-config-leonardo', 'Leonardo'\)\nON CONFLICT DO NOTHING;/u
  );
  assert.match(migrationSql, /'1K',\n {2}'1:1',\n {2}'1024x1024'/u);
  assert.match(migrationSql, /'1K',\n {2}'16:9',\n {2}'1792x1024'/u);
  assert.match(migrationSql, /'1K',\n {2}'9:16',\n {2}'1024x1792'/u);
  assert.equal(
    (migrationSql.match(/ON CONFLICT DO NOTHING;/gu) ?? []).length,
    4
  );
});
