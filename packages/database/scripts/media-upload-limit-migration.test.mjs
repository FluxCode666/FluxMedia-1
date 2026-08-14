/**
 * 0092 媒体上传总量上限迁移静态测试。
 *
 * 职责：确保迁移只更新长期存在的视频持久化校验函数，并以幂等方式把历史
 * 200 MiB 总量边界提升到 512 MiB，避免引用已删除的临时图片迁移函数。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const databasePackageRoot = resolve(scriptDirectory, "..");
const migrationPath = resolve(
  databasePackageRoot,
  "drizzle/0092_media_upload_limit_512mb.sql"
);
const journalPath = resolve(databasePackageRoot, "drizzle/meta/_journal.json");
const releaseGatePath = resolve(
  databasePackageRoot,
  "scripts/release-governance-gate.mjs"
);

test("0092 同步视频数据库总量校验并登记 journal", async () => {
  const [migrationSql, journalText] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(journalPath, "utf8"),
  ]);
  const journal = JSON.parse(journalText);

  assert.doesNotMatch(
    migrationSql,
    /fluxmedia_u1_image_generation_input_is_valid/
  );
  assert.match(
    migrationSql,
    /video_input_manifest_is_valid\(json,text,text,text\)/
  );
  assert.match(migrationSql, /byte_count > 209715200/g);
  assert.match(migrationSql, /total_bytes > 536870912/g);
  assert.match(migrationSql, /pg_get_functiondef/g);
  assert.match(migrationSql, /CREATE OR REPLACE FUNCTION/g);
  assert.ok(
    journal.entries.some(
      (entry) => entry.tag === "0092_media_upload_limit_512mb"
    )
  );
});

test("发布门禁保持单文件 200 MiB 并允许请求合计 512 MiB", async () => {
  const releaseGate = await readFile(releaseGatePath, "utf8");

  assert.match(
    releaseGate,
    /const MEDIA_INPUT_MAX_FILE_BYTES = 200 \* 1024 \* 1024;/
  );
  assert.match(
    releaseGate,
    /const MEDIA_INPUT_MAX_UPLOAD_BYTES = 512 \* 1024 \* 1024;/
  );
  assert.match(
    releaseGate,
    /reference\.byteLength > MEDIA_INPUT_MAX_FILE_BYTES/
  );
  assert.match(releaseGate, /totalBytes > MEDIA_INPUT_MAX_UPLOAD_BYTES/);
  assert.match(releaseGate, /value\.byteLength > MEDIA_INPUT_MAX_FILE_BYTES/);
  assert.match(releaseGate, /imageBytes > MEDIA_INPUT_MAX_UPLOAD_BYTES/);
  assert.doesNotMatch(releaseGate, /VIDEO_INPUT_MAX_BYTES/);
});
