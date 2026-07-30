/**
 * U7 视频历史输入资产收编命令。
 *
 * 仅在旧 Web/worker 全部退出后运行：读取旧 input_image_refs，将 storage/remote 输入
 * 交给纯内核复制到任务前缀，并用逐行 CAS 更新旧列。命令不删除任何源对象，日志只
 * 输出非敏感计数；0074 SQL 在本命令全部成功后才能继续执行。
 */

import { resolve4, resolve6 } from "node:dns/promises";
import { mkdir, open, writeFile } from "node:fs/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

import { migrateVideoInputTask } from "../src/features/image-generation/video-input-migration.ts";

const { Client } = pg;
const CONFIRMATION_FLAG = "--confirm-no-legacy-writers";
const MIGRATION_LOCK_NAME = "video_input_asset_migration_v1";
const REMOTE_TIMEOUT_MS = 30_000;
const MAX_REMOTE_REDIRECTS = 3;
const TASK_PAGE_SIZE = 50;
const STORAGE_SETTING_KEYS = [
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET_NAME",
  "LOCAL_STORAGE_PATH",
];

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
const BLOCKED_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["2001:10::", 28],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

/** 构造迁移专用的公网地址阻断表。 */
function createBlockedAddressLists() {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [address, prefix] of BLOCKED_IPV4_CIDRS) {
    ipv4.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of BLOCKED_IPV6_CIDRS) {
    ipv6.addSubnet(address, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
}

const BLOCKED_ADDRESS_LISTS = createBlockedAddressLists();

/** 校验唯一确认参数，避免在线旧 worker 与迁移命令并发写入。 */
function assertConfirmation(argumentsList) {
  const normalized = argumentsList.filter((argument) => argument !== "--");
  if (normalized.length !== 1 || normalized[0] !== CONFIRMATION_FLAG) {
    throw new RangeError(
      `必须仅传入 ${CONFIRMATION_FLAG}，并确认所有旧 Web/worker 已退出`
    );
  }
}

/** 把 DB JSON 设置值收窄为运行时文本，并保留环境变量回退语义。 */
function readSetting(settings, key, fallback) {
  const stored = settings.get(key);
  if (
    typeof stored === "string" ||
    typeof stored === "number" ||
    typeof stored === "boolean"
  ) {
    const normalized = String(stored).trim();
    if (normalized) return normalized;
  }
  return process.env[key]?.trim() || fallback;
}

/** 读取对象存储所需的最小系统设置，不输出任何设置值。 */
async function loadStorageConfig(client) {
  const result = await client.query(
    `SELECT key, value
       FROM system_setting
      WHERE key = ANY($1::text[])`,
    [STORAGE_SETTING_KEYS]
  );
  const settings = new Map(result.rows.map((row) => [row.key, row.value]));
  return {
    accessKeyId: readSetting(settings, "STORAGE_ACCESS_KEY_ID", null),
    secretAccessKey: readSetting(settings, "STORAGE_SECRET_ACCESS_KEY", null),
    endpoint: readSetting(settings, "STORAGE_ENDPOINT", null),
    region: readSetting(settings, "STORAGE_REGION", "auto"),
    bucketName: readSetting(
      settings,
      "STORAGE_BUCKET_NAME",
      "gpt2image-uploads"
    ),
    localStoragePath: readSetting(settings, "LOCAL_STORAGE_PATH", "./storage"),
  };
}

/** 解析并限制本地对象路径始终位于配置根目录与 bucket 下。 */
function resolveLocalObjectPath(config, bucket, key) {
  if (key.includes("..") || bucket.includes("..") || key.startsWith("/")) {
    throw new Error("本地存储对象路径无效");
  }
  const configuredBase =
    config.localStoragePath === "~" || config.localStoragePath.startsWith("~/")
      ? join(homedir(), config.localStoragePath.slice(2))
      : config.localStoragePath;
  const resolvedBase = resolve(configuredBase, bucket);
  const resolvedObject = resolve(configuredBase, bucket, key);
  if (
    resolvedObject !== resolvedBase &&
    !resolvedObject.startsWith(`${resolvedBase}${sep}`)
  ) {
    throw new Error("本地存储对象路径无效");
  }
  return resolvedObject;
}

/** 将 S3 streaming body 完整读取为 Buffer。 */
async function readS3Body(body, maxBytes, declaredBytes) {
  if (!body) throw new Error("存储对象不存在");
  if (typeof declaredBytes === "number" && declaredBytes > maxBytes) {
    throw new Error("存储对象超过声明大小");
  }
  const chunks = [];
  let totalBytes = 0;
  const reader = body.transformToWebStream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("存储对象超过声明大小");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** 只把明确的对象不存在错误收窄为幂等探测未命中。 */
function isStorageNotFound(error) {
  return (
    (error instanceof Error && "code" in error && error.code === "ENOENT") ||
    (error &&
      typeof error === "object" &&
      (error.name === "NoSuchKey" ||
        error.name === "NotFound" ||
        error.$metadata?.httpStatusCode === 404))
  );
}

/** 创建与当前系统设置绑定的本地或 S3 迁移 provider。 */
function createMigrationStorage(config) {
  if (!config.endpoint) {
    const read = async (input) => {
      const handle = await open(
        resolveLocalObjectPath(config, input.storageBucket, input.storageKey),
        "r"
      );
      try {
        const metadata = await handle.stat();
        if (metadata.size > input.maxBytes) {
          throw new Error("存储对象超过声明大小");
        }
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    };
    return {
      async readStorage(input) {
        return read(input);
      },
      async readStorageIfExists(input) {
        try {
          return await read(input);
        } catch (error) {
          if (isStorageNotFound(error)) return null;
          throw error;
        }
      },
      async putStorage(input) {
        const filePath = resolveLocalObjectPath(
          config,
          input.storageBucket,
          input.storageKey
        );
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, input.data);
      },
      close() {},
    };
  }

  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error("S3 存储配置不完整");
  }
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const read = async (input) => {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: input.storageBucket,
        Key: input.storageKey,
      })
    );
    return readS3Body(response.Body, input.maxBytes, response.ContentLength);
  };
  return {
    async readStorage(input) {
      return read(input);
    },
    async readStorageIfExists(input) {
      try {
        return await read(input);
      } catch (error) {
        if (isStorageNotFound(error)) return null;
        throw error;
      }
    },
    async putStorage(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.storageBucket,
          Key: input.storageKey,
          Body: input.data,
          ContentType: input.mimeType,
        })
      );
    },
    close() {
      client.destroy();
    },
  };
}

/** 判断解析得到的 IP 是否属于私网、保留或不可路由地址。 */
function isBlockedAddress(address) {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    return BLOCKED_ADDRESS_LISTS.ipv4.check(normalized, "ipv4");
  }
  if (version === 6) {
    return BLOCKED_ADDRESS_LISTS.ipv6.check(normalized, "ipv6");
  }
  return true;
}

/** 解析并校验远程主机的全部地址，然后返回一个可被固定连接的公网地址。 */
async function resolvePinnedAddress(url) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    hostname.toLowerCase() === "localhost" ||
    hostname.toLowerCase().endsWith(".localhost") ||
    hostname.toLowerCase().endsWith(".internal")
  ) {
    throw new Error("远程输入地址不可访问");
  }
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error("远程输入地址不可访问");
    }
    return hostname;
  }
  const [ipv4, ipv6] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const addresses = [
    ...(ipv4.status === "fulfilled" ? ipv4.value : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value : []),
  ];
  if (
    addresses.length === 0 ||
    addresses.some((address) => isBlockedAddress(address))
  ) {
    throw new Error("远程输入地址不可访问");
  }
  return addresses[0];
}

/** 使用已解析公网 IP 发起单跳 HTTPS 请求，连接阶段不再重新解析 DNS。 */
async function requestPinnedRemote(url, expectedMimeType, maxBytes) {
  const address = await resolvePinnedAddress(url);
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectRequest(error);
    };
    const request = https.request(
      {
        protocol: "https:",
        hostname: address,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: isIP(url.hostname) ? undefined : url.hostname,
        headers: { Host: url.host },
      },
      (response) => {
        response.once("error", fail);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400) {
          response.resume();
          response.once("end", () => {
            if (settled) return;
            settled = true;
            resolveRequest({ status, location, data: Buffer.alloc(0) });
          });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          response.once("end", () => fail(new Error("远程输入请求失败")));
          return;
        }
        const contentType = String(response.headers["content-type"] ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== expectedMimeType) {
          response.destroy(new Error("远程输入 MIME 不一致"));
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy(new Error("远程输入超过声明大小"));
          return;
        }
        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > maxBytes) {
            response.destroy(new Error("远程输入超过声明大小"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          resolveRequest({ status, location, data: Buffer.concat(chunks) });
        });
      }
    );
    request.setTimeout(REMOTE_TIMEOUT_MS, () => {
      request.destroy(new Error("远程输入请求超时"));
    });
    request.once("error", fail);
    request.end();
  });
}

/** 逐跳复验 remote 重定向并返回受字节上限保护的图片内容。 */
async function readRemoteInput(input) {
  let currentUrl = new URL(input.url);
  for (let hop = 0; hop <= MAX_REMOTE_REDIRECTS; hop += 1) {
    if (
      currentUrl.protocol !== "https:" ||
      currentUrl.username ||
      currentUrl.password
    ) {
      throw new Error("远程输入 URL 无效");
    }
    const response = await requestPinnedRemote(
      currentUrl,
      input.mimeType,
      input.maxBytes
    );
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error("远程输入重定向无效");
      currentUrl = new URL(response.location, currentUrl);
      continue;
    }
    return response.data;
  }
  throw new Error("远程输入重定向次数过多");
}

/** 用 JSON 语义 CAS 更新单个任务，竞争后已是相同结果时视为幂等成功。 */
async function persistMigratedReferences(client, input) {
  const expectedJson = JSON.stringify(input.expectedInputImageRefs);
  const migratedJson = JSON.stringify(input.migratedInputImageRefs);
  const updated = await client.query(
    `UPDATE video_generation
        SET input_image_refs = $2::json,
            updated_at = NOW()
      WHERE id = $1
        AND input_image_refs::jsonb = $3::jsonb
      RETURNING id`,
    [input.taskId, migratedJson, expectedJson]
  );
  if (updated.rowCount === 1) return;
  const current = await client.query(
    `SELECT input_image_refs::jsonb = $2::jsonb AS matches
       FROM video_generation
      WHERE id = $1`,
    [input.taskId, migratedJson]
  );
  if (current.rows[0]?.matches === true) return;
  throw new Error("任务输入在迁移期间发生并发变化");
}

/** 判断资产收编应执行旧列迁移，还是 0074 已完成后的幂等空操作。 */
async function readMigrationSchemaState(client) {
  const result = await client.query(`
    SELECT
      to_regclass('public.video_generation') IS NOT NULL AS table_present,
      count(*) FILTER (
        WHERE column_name IN (
          'family', 'input_image_refs', 'staged_input_objects'
        )
      )::integer AS legacy_column_count,
      count(*) FILTER (
        WHERE column_name = 'input_manifest'
      )::integer AS manifest_column_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'video_generation'
  `);
  const state = result.rows[0] ?? {};
  if (
    state.table_present === true &&
    state.legacy_column_count === 3 &&
    state.manifest_column_count === 1
  ) {
    return "legacy";
  }
  if (
    state.table_present === true &&
    state.legacy_column_count === 0 &&
    state.manifest_column_count === 1
  ) {
    return "applied";
  }
  throw new Error("视频输入资产收编遇到部分迁移 schema");
}

/** 分页查询仍含旧输入列的任务；空数组和非法值也交给纯内核阻断。 */
async function listTasksWithLegacyInputs(client, afterTaskId) {
  const result = await client.query(
    `SELECT id,
            user_id,
            input_image_refs
       FROM video_generation
      WHERE input_image_refs IS NOT NULL
        AND ($1::text IS NULL OR id > $1)
      ORDER BY id
      LIMIT $2`,
    [afterTaskId, TASK_PAGE_SIZE]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    inputImageRefs: row.input_image_refs,
  }));
}

/** 依次收编全部任务并仅累加可公开计数。 */
async function runAssetMigration(client, storage, bucketName) {
  const summary = {
    status: "complete",
    taskCount: 0,
    migratedTaskCount: 0,
    verifiedTaskCount: 0,
    inputCount: 0,
    copiedObjectCount: 0,
    verifiedObjectCount: 0,
  };
  let afterTaskId = null;
  while (true) {
    const tasks = await listTasksWithLegacyInputs(client, afterTaskId);
    if (tasks.length === 0) break;
    for (const task of tasks) {
      const result = await migrateVideoInputTask(task, {
        currentBucket: bucketName,
        readStorage: storage.readStorage,
        readStorageIfExists: storage.readStorageIfExists,
        readRemote: readRemoteInput,
        putStorage: storage.putStorage,
        persistTaskInputReferences: (input) =>
          persistMigratedReferences(client, input),
      });
      summary.taskCount += 1;
      if (result.status === "migrated") summary.migratedTaskCount += 1;
      else summary.verifiedTaskCount += 1;
      summary.inputCount += result.inputCount;
      summary.copiedObjectCount += result.copiedCount;
      summary.verifiedObjectCount += result.verifiedCount;
    }
    afterTaskId = tasks.at(-1)?.id ?? null;
  }
  return summary;
}

/** 连接数据库、持有单实例锁并执行显式资产收编。 */
export async function main(argumentsList = process.argv.slice(2)) {
  assertConfirmation(argumentsList);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL 环境变量未设置");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let lockAcquired = false;
  let storage;
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [MIGRATION_LOCK_NAME]
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) throw new Error("已有视频输入资产收编命令正在运行");
    if ((await readMigrationSchemaState(client)) === "applied") {
      console.log(
        JSON.stringify({
          status: "already_applied",
          taskCount: 0,
          migratedTaskCount: 0,
          verifiedTaskCount: 0,
          inputCount: 0,
          copiedObjectCount: 0,
          verifiedObjectCount: 0,
        })
      );
      return;
    }
    const storageConfig = await loadStorageConfig(client);
    storage = createMigrationStorage(storageConfig);
    const summary = await runAssetMigration(
      client,
      storage,
      storageConfig.bucketName
    );
    console.log(JSON.stringify(summary));
  } finally {
    storage?.close();
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        MIGRATION_LOCK_NAME,
      ]);
    }
    await client.end();
  }
}

/** 仅在直接运行时转成稳定非零退出码，测试导入不会触达数据库。 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "未知资产迁移错误");
    process.exitCode = 1;
  });
}
