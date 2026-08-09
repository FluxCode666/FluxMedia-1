/**
 * 控制台统计读模型的可恢复回填与对账命令。
 *
 * 输出用量和积分操作分别使用 snapshot、全量 catch-up、稳定 `(created_at,id)` 游标和
 * 分批事务。每批业务写入与状态游标同事务提交；中断后可直接重跑。账本是财务权威；
 * generation/video_generation 用于补齐仍存在任务的成功事件，已写事件保留被删除画廊
 * 记录的历史用量事实。任何证据不足、归属冲突或对账差异都会非零退出。
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  buildOutputUsageReconciliationSql,
  creditOperationKey,
  hasReconciliationDifference,
  parseBackfillOptions,
  resolveBackfillCreditOperation,
  resolveBackfillImageOutputCount,
} from "./dashboard-analytics-backfill-core.mjs";

const { Client } = pg;
const READ_MODEL_VERSION = 1;
const BACKFILL_LOCK_NAME = "dashboard_analytics_backfill_v1";
const TIMESTAMP_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.US`;

/** 把 pg 的 bigint/count 或 numeric 文本安全收窄为有限数字。 */
function databaseNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`数据库返回非法数值 ${field}`);
  }
  return parsed;
}

/** 返回新对象，避免直接修改从 JSON 状态列读取的 details。 */
function copyDetails(details) {
  return details && typeof details === "object" && !Array.isArray(details)
    ? structuredClone(details)
    : {};
}

/** 将游标规范化为状态表使用的最小 JSON 结构。 */
function cursorFromRow(row) {
  return row
    ? { createdAt: row.created_at, id: row.cursor_id ?? row.id }
    : null;
}

/** 创建一条状态行并读取当前部署/恢复状态。 */
async function ensureReadModelState(client, readModel) {
  await client.query(
    `INSERT INTO analytics_read_model_state
      (read_model, version, status, created_at, updated_at)
     VALUES ($1, $2, 'building', now(), now())
     ON CONFLICT (read_model) DO NOTHING`,
    [readModel, READ_MODEL_VERSION]
  );
  const result = await client.query(
    `SELECT read_model, version, status,
            snapshot_high_water, catch_up_water, details
       FROM analytics_read_model_state
      WHERE read_model = $1`,
    [readModel]
  );
  if (result.rows.length !== 1) {
    throw new Error(`无法读取 ${readModel} 回填状态`);
  }
  return result.rows[0];
}

/** 在当前事务内更新状态、水位和恢复详情。 */
async function writeReadModelState(client, readModel, values) {
  await client.query(
    `UPDATE analytics_read_model_state
        SET version = $2,
            status = $3::analytics_read_model_status,
            snapshot_high_water = $4::jsonb,
            catch_up_water = $5::jsonb,
            details = $6::jsonb,
            last_reconciled_at = $7::timestamp,
            updated_at = now()
      WHERE read_model = $1`,
    [
      readModel,
      READ_MODEL_VERSION,
      values.status,
      values.snapshotHighWater
        ? JSON.stringify(values.snapshotHighWater)
        : null,
      values.catchUpWater ? JSON.stringify(values.catchUpWater) : null,
      JSON.stringify(values.details ?? {}),
      values.lastReconciledAt ?? null,
    ]
  );
}

/** 在单连接上运行事务；异常时显式回滚并保留原始失败。 */
async function inTransaction(client, callback) {
  await client.query("BEGIN");
  try {
    const result = await callback();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** 捕获输出任务在当前时刻的稳定复合高水位。 */
async function readOutputHighWater(client) {
  const result = await client.query(
    `SELECT to_char(created_at, '${TIMESTAMP_FORMAT}') AS created_at,
            cursor_id
       FROM (
         SELECT created_at, 'image:' || id AS cursor_id
           FROM generation
          WHERE status = 'completed'
         UNION ALL
         SELECT created_at, 'video:' || id AS cursor_id
           FROM video_generation
          WHERE status = 'completed'
       ) source
      ORDER BY created_at DESC, cursor_id DESC
      LIMIT 1`
  );
  return cursorFromRow(result.rows[0]);
}

/** 读取一个输出任务批次；synthetic cursor ID 为跨表稳定排序补上第三维。 */
async function readOutputBatch(client, cursor, highWater, batchSize) {
  if (!highWater) return [];
  const result = await client.query(
    `SELECT output_kind, cursor_id, source_task_id, user_id,
            to_char(created_at, '${TIMESTAMP_FORMAT}') AS created_at,
            status, storage_key, metadata, duration_seconds
       FROM (
         SELECT 'image'::text AS output_kind,
                'image:' || id AS cursor_id,
                id AS source_task_id,
                user_id,
                created_at,
                status::text AS status,
                storage_key,
                metadata,
                NULL::integer AS duration_seconds
           FROM generation
          WHERE status = 'completed'
         UNION ALL
         SELECT 'video'::text AS output_kind,
                'video:' || id AS cursor_id,
                id AS source_task_id,
                user_id,
                created_at,
                status::text AS status,
                storage_key,
                metadata,
                duration_seconds
           FROM video_generation
          WHERE status = 'completed'
       ) source
      WHERE (
              $1::timestamp IS NULL
              OR created_at > $1::timestamp
              OR (created_at = $1::timestamp AND cursor_id > $2)
            )
        AND (
              created_at < $3::timestamp
              OR (created_at = $3::timestamp AND cursor_id <= $4)
            )
      ORDER BY created_at, cursor_id
      LIMIT $5`,
    [
      cursor?.createdAt ?? null,
      cursor?.id ?? "",
      highWater.createdAt,
      highWater.id,
      batchSize,
    ]
  );
  return result.rows;
}

/** 将权威输出任务行变成可写事件；明确零产物会返回 null。 */
function buildOutputUsageEvent(row) {
  if (row.output_kind === "image") {
    const resolved = resolveBackfillImageOutputCount({
      status: row.status,
      storageKey: row.storage_key,
      metadata: row.metadata,
    });
    if (resolved.status === "insufficientEvidence") {
      throw new Error(`图片任务 ${row.source_task_id} 完成但缺少产物证据`);
    }
    if (resolved.status === "notCounted") return null;
    return {
      output_kind: "image",
      source_task_id: row.source_task_id,
      user_id: row.user_id,
      operation_created_at: row.created_at,
      image_count: resolved.count,
      video_seconds: 0,
    };
  }
  if (row.output_kind !== "video") {
    throw new Error(`未知产物类型：${row.output_kind}`);
  }
  const durationSeconds = databaseNumber(
    row.duration_seconds,
    "video.duration_seconds"
  );
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`视频任务 ${row.source_task_id} 已完成但秒数非法`);
  }
  return {
    output_kind: "video",
    source_task_id: row.source_task_id,
    user_id: row.user_id,
    operation_created_at: row.created_at,
    image_count: 0,
    video_seconds: durationSeconds,
  };
}

/**
 * 原子写入输出事件、条件递增汇总并推进当前阶段游标。
 *
 * 已存在事件必须与权威任务逐字段一致；冲突不是普通重放时整个批次回滚。
 */
async function applyOutputBatch(client, rows, events, state, details, phase) {
  const cursor = cursorFromRow(rows.at(-1));
  await inTransaction(client, async () => {
    const writeResult = await client.query(
      `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS item(
             output_kind text,
             source_task_id text,
             user_id text,
             operation_created_at text,
             image_count integer,
             video_seconds integer
           )
       ), conflicts AS (
         SELECT count(*)::integer AS count
           FROM input
           JOIN user_output_usage_event existing
             ON existing.output_kind = input.output_kind::output_usage_kind
            AND existing.source_task_id = input.source_task_id
          WHERE existing.user_id IS DISTINCT FROM input.user_id
             OR existing.operation_created_at IS DISTINCT FROM input.operation_created_at::timestamp
             OR existing.image_count IS DISTINCT FROM input.image_count
             OR existing.video_seconds IS DISTINCT FROM input.video_seconds
       ), inserted AS (
         INSERT INTO user_output_usage_event (
           output_kind, source_task_id, user_id, operation_created_at,
           image_count, video_seconds
         )
         SELECT output_kind::output_usage_kind, source_task_id, user_id,
                operation_created_at::timestamp, image_count, video_seconds
           FROM input
         ON CONFLICT (output_kind, source_task_id) DO NOTHING
         RETURNING user_id, image_count, video_seconds
       ), increments AS (
         INSERT INTO user_usage_summary (
           user_id, total_image_count, total_video_seconds, created_at, updated_at
         )
         SELECT user_id, sum(image_count), sum(video_seconds), now(), now()
           FROM inserted
          GROUP BY user_id
         ON CONFLICT (user_id) DO UPDATE
           SET total_image_count = user_usage_summary.total_image_count
               + EXCLUDED.total_image_count,
               total_video_seconds = user_usage_summary.total_video_seconds
               + EXCLUDED.total_video_seconds,
               updated_at = now()
         RETURNING user_id
       )
       SELECT (SELECT count FROM conflicts) AS conflict_count,
              (SELECT count(*)::integer FROM inserted) AS inserted_count`,
      [JSON.stringify(events)]
    );
    const result = writeResult.rows[0];
    if (databaseNumber(result.conflict_count, "output.conflict_count") > 0) {
      throw new Error("产物事件与权威任务内容不一致");
    }

    const nextDetails = copyDetails(details);
    nextDetails[`${phase}Cursor`] = cursor;
    nextDetails.processedRows =
      databaseNumber(nextDetails.processedRows ?? 0, "processedRows") +
      rows.length;
    nextDetails.insertedEvents =
      databaseNumber(nextDetails.insertedEvents ?? 0, "insertedEvents") +
      databaseNumber(result.inserted_count, "output.inserted_count");
    await writeReadModelState(client, "output_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details: nextDetails,
      lastReconciledAt: null,
    });
    Object.assign(details, nextDetails);
  });
}

/** 运行输出模型的一个 snapshot 或 catch-up pass。 */
async function runOutputPass(
  client,
  state,
  details,
  phase,
  highWater,
  batchSize
) {
  let cursor = details[`${phase}Cursor`] ?? null;
  while (true) {
    const rows = await readOutputBatch(client, cursor, highWater, batchSize);
    if (rows.length === 0) return;
    const events = rows
      .map(buildOutputUsageEvent)
      .filter((event) => event !== null);
    await applyOutputBatch(client, rows, events, state, details, phase);
    cursor = details[`${phase}Cursor`];
    console.log(
      `[output_usage] ${phase} 已处理到 ${cursor.createdAt}/${cursor.id}`
    );
  }
}

/** 捕获积分账本当前稳定高水位。 */
async function readCreditHighWater(client, transactionType) {
  const result = await client.query(
    `SELECT to_char(created_at, '${TIMESTAMP_FORMAT}') AS created_at, id
       FROM credits_transaction
      WHERE type = $1::credits_transaction_type
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [transactionType]
  );
  return cursorFromRow(result.rows[0]);
}

/** 按稳定游标读取消费与退款账本批次。 */
async function readCreditBatch(
  client,
  cursor,
  highWater,
  batchSize,
  transactionType
) {
  if (!highWater) return [];
  const result = await client.query(
    `SELECT id, user_id, type::text, amount::text, source_ref,
            debit_account, credit_account, metadata,
            operation_type, operation_id,
            CASE WHEN operation_created_at IS NULL THEN NULL
                 ELSE to_char(operation_created_at, '${TIMESTAMP_FORMAT}') END
              AS operation_created_at,
            to_char(created_at, '${TIMESTAMP_FORMAT}') AS created_at
       FROM credits_transaction
      WHERE type = $6::credits_transaction_type
        AND (
              $1::timestamp IS NULL
              OR created_at > $1::timestamp
              OR (created_at = $1::timestamp AND id > $2)
            )
        AND (
              created_at < $3::timestamp
              OR (created_at = $3::timestamp AND id <= $4)
            )
      ORDER BY created_at, id
      LIMIT $5`,
    [
      cursor?.createdAt ?? null,
      cursor?.id ?? "",
      highWater.createdAt,
      highWater.id,
      batchSize,
      transactionType,
    ]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amount: row.amount,
    sourceRef: row.source_ref,
    debitAccount: row.debit_account,
    creditAccount: row.credit_account,
    metadata: row.metadata,
    operationType: row.operation_type,
    operationId: row.operation_id,
    operationCreatedAt: row.operation_created_at,
    createdAt: row.created_at,
  }));
}

/** 收集当前批次可能引用的业务任务和计费操作键。 */
function collectCreditEvidenceCandidates(rows) {
  const taskIds = new Set();
  const operationKeys = new Map();
  const blockRepairOutputIds = new Set();
  for (const row of rows) {
    const metadata =
      row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const generationId =
      typeof metadata.generationId === "string"
        ? metadata.generationId.trim()
        : "";
    const videoGenerationId =
      typeof metadata.videoGenerationId === "string"
        ? metadata.videoGenerationId.trim()
        : "";
    const taskId =
      typeof metadata.taskId === "string" ? metadata.taskId.trim() : "";
    if (
      metadata.blockRepair === true &&
      Number.isInteger(metadata.index) &&
      typeof row.sourceRef === "string"
    ) {
      const suffix = `:blockrepair-${metadata.index}`;
      if (row.sourceRef.endsWith(suffix)) {
        blockRepairOutputIds.add(row.sourceRef.slice(0, -suffix.length));
      }
    }
    if (generationId) taskIds.add(generationId);
    if (videoGenerationId) taskIds.add(videoGenerationId);
    const candidates = [];
    if (row.operationType && row.operationId) {
      candidates.push([row.operationType, row.operationId]);
      if (
        row.operationType === "image_generation" ||
        row.operationType === "video_generation"
      ) {
        taskIds.add(row.operationId);
      }
    }
    if (generationId) {
      candidates.push(["image_generation", generationId]);
      candidates.push(["video_generation", generationId]);
    }
    if (videoGenerationId) {
      candidates.push(["video_generation", videoGenerationId]);
    }
    if (taskId && (metadata.kind === "ppt" || metadata.kind === "psd")) {
      candidates.push([`editable_file_${metadata.kind}`, taskId]);
    }
    for (const [operationType, operationId] of candidates) {
      const key = creditOperationKey(row.userId, operationType, operationId);
      operationKeys.set(key, {
        user_id: row.userId,
        operation_type: operationType,
        operation_id: operationId,
      });
    }
  }
  return {
    taskIds: [...taskIds],
    operationKeys: [...operationKeys.values()],
    blockRepairOutputIds: [...blockRepairOutputIds],
  };
}

/**
 * 批量读取任务或不可变产物事件时间，以及已投影 operation 时间。
 *
 * 画廊历史硬删可能移除 generation，但成功事件与账本仍保留；事件创建时间可继续证明
 * 对应图片/视频计费操作，且与仍存在任务同时出现时必须逐值一致。
 */
async function loadCreditEvidence(client, rows) {
  const candidates = collectCreditEvidenceCandidates(rows);
  const evidence = {
    imageCreatedAtByKey: new Map(),
    videoCreatedAtByKey: new Map(),
    operationCreatedAtByKey: new Map(),
    blockRepairParentByOutputKey: new Map(),
  };
  if (candidates.taskIds.length > 0) {
    const tasks = await client.query(
      `SELECT kind, id, user_id,
              to_char(created_at, '${TIMESTAMP_FORMAT}') AS created_at
         FROM (
           SELECT 'image'::text AS kind, id, user_id, created_at
             FROM generation
            WHERE id = ANY($1::text[])
           UNION ALL
           SELECT 'video'::text AS kind, id, user_id, created_at
             FROM video_generation
            WHERE id = ANY($1::text[])
           UNION ALL
           SELECT output_kind::text AS kind, source_task_id AS id, user_id,
                  operation_created_at AS created_at
             FROM user_output_usage_event
            WHERE source_task_id = ANY($1::text[])
         ) tasks`,
      [candidates.taskIds]
    );
    for (const task of tasks.rows) {
      const key = creditOperationKey(task.user_id, "task", task.id);
      const target =
        task.kind === "image"
          ? evidence.imageCreatedAtByKey
          : evidence.videoCreatedAtByKey;
      const existingCreatedAt = target.get(key);
      if (existingCreatedAt && existingCreatedAt !== task.created_at) {
        throw new Error(`任务与产物事件 ${task.id} 的创建时间不一致`);
      }
      target.set(key, task.created_at);
    }
  }
  if (candidates.operationKeys.length > 0) {
    const operations = await client.query(
      `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS item(
             user_id text,
             operation_type text,
             operation_id text
           )
       )
       SELECT operation.user_id, operation.operation_type,
              operation.operation_id,
              to_char(operation.operation_created_at, '${TIMESTAMP_FORMAT}')
                AS operation_created_at
         FROM input
         JOIN credit_usage_operation operation
           ON operation.user_id = input.user_id
          AND operation.operation_type = input.operation_type
          AND operation.operation_id = input.operation_id`,
      [JSON.stringify(candidates.operationKeys)]
    );
    for (const operation of operations.rows) {
      evidence.operationCreatedAtByKey.set(
        creditOperationKey(
          operation.user_id,
          operation.operation_type,
          operation.operation_id
        ),
        operation.operation_created_at
      );
    }
  }
  if (candidates.blockRepairOutputIds.length > 0) {
    const parents = await client.query(
      `SELECT generation.id, generation.user_id,
              to_char(generation.created_at, '${TIMESTAMP_FORMAT}')
                AS created_at,
              output ->> 'generationId' AS output_generation_id
         FROM generation
         CROSS JOIN LATERAL jsonb_array_elements(
           coalesce(
             generation.metadata::jsonb #> '{outputImage,imageOutputs}',
             '[]'::jsonb
           )
         ) output
        WHERE output ->> 'generationId' = ANY($1::text[])`,
      [candidates.blockRepairOutputIds]
    );
    for (const parent of parents.rows) {
      const key = creditOperationKey(
        parent.user_id,
        "output",
        parent.output_generation_id
      );
      if (evidence.blockRepairParentByOutputKey.has(key)) {
        throw new Error(
          `生成式修复输出 ${parent.output_generation_id} 命中多个父任务`
        );
      }
      evidence.blockRepairParentByOutputKey.set(key, {
        generationId: parent.id,
        createdAt: parent.created_at,
      });
    }
  }
  return evidence;
}

/**
 * 验证历史退款与 refund batch 的用户、金额、batch ID 和完整 sourceRef 一致。
 *
 * 旧账本顶层 source_ref 可能为空；metadata 与 batch 必须提供同一个非空幂等键，
 * 顶层字段存在时也必须相同，禁止从 generationId 拼接或截取。
 */
async function verifyRefundBatchEvidence(client, rows) {
  const refunds = rows.filter((row) => row.type === "refund");
  if (refunds.length === 0) return;
  const batchIds = refunds.map((row) => {
    const metadata =
      row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const batchId =
      typeof metadata.batchId === "string" ? metadata.batchId.trim() : "";
    if (!batchId) {
      throw new Error(`退款 ${row.id} 缺少 metadata.batchId`);
    }
    return batchId;
  });
  const result = await client.query(
    `SELECT id, user_id, source_type::text, amount::text, source_ref
       FROM credits_batch
      WHERE id = ANY($1::text[])`,
    [batchIds]
  );
  const batches = new Map(result.rows.map((row) => [row.id, row]));
  for (const row of refunds) {
    const metadata =
      row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const batch = batches.get(metadata.batchId);
    const metadataSourceRef =
      typeof metadata.sourceRef === "string" && metadata.sourceRef.trim()
        ? metadata.sourceRef.trim()
        : null;
    const batchSourceRef =
      typeof batch?.source_ref === "string" && batch.source_ref.trim()
        ? batch.source_ref.trim()
        : null;
    const sourceRefs = [row.sourceRef, metadataSourceRef, batch?.source_ref]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    if (
      !batch ||
      batch.user_id !== row.userId ||
      batch.source_type !== "refund" ||
      batch.amount !== row.amount ||
      !metadataSourceRef ||
      !batchSourceRef ||
      sourceRefs.some((value) => value !== sourceRefs[0])
    ) {
      throw new Error(`退款 ${row.id} 与 credits_batch 证据不一致`);
    }
  }
}

/** 将纯解析结果附加到账本事实，供批量 SQL 写入。 */
async function buildCreditContributions(client, rows) {
  await verifyRefundBatchEvidence(client, rows);
  const evidence = await loadCreditEvidence(client, rows);
  return rows.map((row) => ({
    transaction_id: row.id,
    user_id: row.userId,
    transaction_type: row.type,
    amount: row.amount,
    transaction_created_at: row.createdAt,
    ...(() => {
      const operation = resolveBackfillCreditOperation(row, evidence);
      return {
        operation_type: operation.operationType,
        operation_id: operation.operationId,
        operation_created_at: operation.operationCreatedAt,
      };
    })(),
  }));
}

/** 更新 legacy 账本 context，并验证既有 context 与回填证据完全一致。 */
async function persistAndVerifyLedgerContexts(client, contributions) {
  await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           transaction_created_at text,
           operation_type text,
           operation_id text,
           operation_created_at text
         )
     )
     UPDATE credits_transaction ledger
        SET operation_type = input.operation_type,
            operation_id = input.operation_id,
            operation_created_at = input.operation_created_at::timestamp
       FROM input
      WHERE ledger.id = input.transaction_id
        AND ledger.operation_type IS NULL
        AND ledger.operation_id IS NULL
        AND ledger.operation_created_at IS NULL`,
    [JSON.stringify(contributions)]
  );
  const verification = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           transaction_created_at text,
           operation_type text,
           operation_id text,
           operation_created_at text
         )
     )
     SELECT count(*)::integer AS mismatch_count
       FROM input
       LEFT JOIN credits_transaction ledger ON ledger.id = input.transaction_id
      WHERE ledger.id IS NULL
         OR ledger.user_id IS DISTINCT FROM input.user_id
         OR ledger.type::text IS DISTINCT FROM input.transaction_type
         OR ledger.amount IS DISTINCT FROM input.amount::numeric
         OR ledger.created_at IS DISTINCT FROM input.transaction_created_at::timestamp
         OR ledger.operation_type IS DISTINCT FROM input.operation_type
         OR ledger.operation_id IS DISTINCT FROM input.operation_id
         OR ledger.operation_created_at IS DISTINCT FROM input.operation_created_at::timestamp`,
    [JSON.stringify(contributions)]
  );
  if (
    databaseNumber(
      verification.rows[0].mismatch_count,
      "credit.ledger_context_mismatch"
    ) > 0
  ) {
    throw new Error("历史账本 context 与权威证据不一致");
  }
}

/** 验证 projection transaction 主键冲突不是内容冲突。 */
async function verifyProjectionConflicts(client, contributions) {
  const result = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           transaction_created_at text,
           operation_type text,
           operation_id text,
           operation_created_at text
         )
     )
     SELECT count(*)::integer AS conflict_count
       FROM input
       JOIN credit_usage_projection_entry projected
         ON projected.transaction_id = input.transaction_id
      WHERE projected.user_id IS DISTINCT FROM input.user_id
         OR projected.contribution_kind::text IS DISTINCT FROM input.transaction_type
         OR projected.amount IS DISTINCT FROM input.amount::numeric
         OR projected.operation_type IS DISTINCT FROM input.operation_type
         OR projected.operation_id IS DISTINCT FROM input.operation_id
         OR projected.operation_created_at IS DISTINCT FROM input.operation_created_at::timestamp
         OR projected.transaction_created_at IS DISTINCT FROM input.transaction_created_at::timestamp`,
    [JSON.stringify(contributions)]
  );
  if (
    databaseNumber(
      result.rows[0].conflict_count,
      "credit.projection_conflict"
    ) > 0
  ) {
    throw new Error("账本 projection transaction ID 出现内容冲突");
  }
}

/** 插入唯一贡献，并返回本批首次插入的贡献供后续原子聚合。 */
async function insertCreditContributions(client, contributions) {
  const result = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           transaction_created_at text,
           operation_type text,
           operation_id text,
           operation_created_at text
         )
     )
     INSERT INTO credit_usage_projection_entry (
       transaction_id, user_id, contribution_kind, amount,
       operation_type, operation_id, operation_created_at,
       transaction_created_at
     )
     SELECT transaction_id, user_id,
            transaction_type::credit_usage_contribution_kind,
            amount::numeric, operation_type, operation_id,
            operation_created_at::timestamp,
            transaction_created_at::timestamp
       FROM input
     ON CONFLICT (transaction_id) DO NOTHING
     RETURNING transaction_id, user_id,
               contribution_kind::text AS transaction_type,
               amount::text, operation_type, operation_id,
               to_char(operation_created_at, '${TIMESTAMP_FORMAT}')
                 AS operation_created_at,
               to_char(transaction_created_at, '${TIMESTAMP_FORMAT}')
                 AS transaction_created_at`,
    [JSON.stringify(contributions)]
  );
  return result.rows;
}

/** 聚合并原子应用本批首次消费贡献。 */
async function applyCreditConsumptions(client, inserted) {
  const result = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           operation_type text,
           operation_id text,
           operation_created_at text,
           transaction_created_at text
         )
     ), grouped AS (
       SELECT user_id, operation_type, operation_id,
              operation_created_at::timestamp AS operation_created_at,
              sum(amount::numeric) AS gross_consumed,
              min(transaction_created_at::timestamp) AS created_at,
              max(transaction_created_at::timestamp) AS updated_at
         FROM input
        WHERE transaction_type = 'consumption'
        GROUP BY user_id, operation_type, operation_id,
                 operation_created_at::timestamp
     ), applied AS (
       INSERT INTO credit_usage_operation (
         user_id, operation_type, operation_id, operation_created_at,
         gross_consumed, refunded, net_consumed, created_at, updated_at
       )
       SELECT user_id, operation_type, operation_id, operation_created_at,
              gross_consumed, 0, gross_consumed, created_at, updated_at
         FROM grouped
       ON CONFLICT (user_id, operation_type, operation_id) DO UPDATE
         SET gross_consumed = credit_usage_operation.gross_consumed
             + EXCLUDED.gross_consumed,
             net_consumed = credit_usage_operation.net_consumed
             + EXCLUDED.gross_consumed,
             updated_at = GREATEST(
               credit_usage_operation.updated_at,
               EXCLUDED.updated_at
             )
       WHERE credit_usage_operation.operation_created_at
             = EXCLUDED.operation_created_at
       RETURNING user_id, operation_type, operation_id
     )
     SELECT (SELECT count(*)::integer FROM grouped) AS expected_count,
            (SELECT count(*)::integer FROM applied) AS applied_count`,
    [JSON.stringify(inserted)]
  );
  const counts = result.rows[0];
  if (
    databaseNumber(counts.expected_count, "credit.consumption_expected") !==
    databaseNumber(counts.applied_count, "credit.consumption_applied")
  ) {
    throw new Error("消费 operation 创建时间冲突");
  }
}

/** 锁定并应用本批首次退款贡献，严格拒绝孤立或超额退款。 */
async function applyCreditRefunds(client, inserted) {
  const result = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_id text,
           user_id text,
           transaction_type text,
           amount text,
           operation_type text,
           operation_id text,
           operation_created_at text,
           transaction_created_at text
         )
     ), grouped AS (
       SELECT user_id, operation_type, operation_id,
              operation_created_at::timestamp AS operation_created_at,
              sum(amount::numeric) AS refund_amount,
              min(transaction_created_at::timestamp) AS earliest_refund_at,
              max(transaction_created_at::timestamp) AS updated_at
         FROM input
        WHERE transaction_type = 'refund'
        GROUP BY user_id, operation_type, operation_id,
                 operation_created_at::timestamp
     ), applied AS (
       UPDATE credit_usage_operation operation
          SET refunded = operation.refunded + grouped.refund_amount,
              net_consumed = operation.net_consumed - grouped.refund_amount,
              updated_at = GREATEST(operation.updated_at, grouped.updated_at)
         FROM grouped
        WHERE operation.user_id = grouped.user_id
          AND operation.operation_type = grouped.operation_type
          AND operation.operation_id = grouped.operation_id
          AND operation.operation_created_at = grouped.operation_created_at
          AND operation.gross_consumed - operation.refunded
              >= grouped.refund_amount
          AND grouped.earliest_refund_at >= (
            SELECT min(projected.transaction_created_at)
              FROM credit_usage_projection_entry projected
             WHERE projected.user_id = grouped.user_id
               AND projected.operation_type = grouped.operation_type
               AND projected.operation_id = grouped.operation_id
               AND projected.contribution_kind = 'consumption'
          )
       RETURNING operation.user_id, operation.operation_type,
                 operation.operation_id
     )
     SELECT (SELECT count(*)::integer FROM grouped) AS expected_count,
            (SELECT count(*)::integer FROM applied) AS applied_count`,
    [JSON.stringify(inserted)]
  );
  const counts = result.rows[0];
  if (
    databaseNumber(counts.expected_count, "credit.refund_expected") !==
    databaseNumber(counts.applied_count, "credit.refund_applied")
  ) {
    throw new Error("退款孤立、早于原消费、创建时间冲突或超过原操作可退毛消费");
  }
}

/** 首次退款贡献成功后同步递增账户累计退款。 */
async function applyCreditRefundBalances(client, inserted) {
  const result = await client.query(
    `WITH input AS (
       SELECT *
         FROM jsonb_to_recordset($1::jsonb) AS item(
           user_id text,
           transaction_type text,
           amount text
         )
     ), grouped AS (
       SELECT user_id, sum(amount::numeric) AS refund_amount
         FROM input
        WHERE transaction_type = 'refund'
        GROUP BY user_id
     ), applied AS (
       UPDATE credits_balance balance
          SET total_refunded = balance.total_refunded + grouped.refund_amount,
              updated_at = now()
         FROM grouped
        WHERE balance.user_id = grouped.user_id
       RETURNING balance.user_id
     )
     SELECT (SELECT count(*)::integer FROM grouped) AS expected_count,
            (SELECT count(*)::integer FROM applied) AS applied_count`,
    [JSON.stringify(inserted)]
  );
  const counts = result.rows[0];
  if (
    databaseNumber(counts.expected_count, "credit.balance_expected") !==
    databaseNumber(counts.applied_count, "credit.balance_applied")
  ) {
    throw new Error("退款用户缺少 credits_balance 账户");
  }
}

/** 在同一事务应用账本 context、贡献、操作聚合、累计退款和恢复游标。 */
async function applyCreditBatch(
  client,
  rows,
  contributions,
  state,
  details,
  phase
) {
  const cursor = {
    createdAt: rows.at(-1).createdAt,
    id: rows.at(-1).id,
  };
  await inTransaction(client, async () => {
    await persistAndVerifyLedgerContexts(client, contributions);
    await verifyProjectionConflicts(client, contributions);
    const inserted = await insertCreditContributions(client, contributions);
    await applyCreditConsumptions(client, inserted);
    await applyCreditRefunds(client, inserted);
    await applyCreditRefundBalances(client, inserted);

    const nextDetails = copyDetails(details);
    nextDetails[`${phase}Cursor`] = cursor;
    nextDetails.processedRows =
      databaseNumber(nextDetails.processedRows ?? 0, "processedRows") +
      rows.length;
    nextDetails.insertedContributions =
      databaseNumber(
        nextDetails.insertedContributions ?? 0,
        "insertedContributions"
      ) + inserted.length;
    await writeReadModelState(client, "credit_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details: nextDetails,
      lastReconciledAt: null,
    });
    Object.assign(details, nextDetails);
  });
}

/** 运行积分模型的一个 snapshot 或 catch-up pass。 */
async function runCreditPass(
  client,
  state,
  details,
  phase,
  highWater,
  batchSize,
  transactionType
) {
  let cursor = details[`${phase}Cursor`] ?? null;
  while (true) {
    const rows = await readCreditBatch(
      client,
      cursor,
      highWater,
      batchSize,
      transactionType
    );
    if (rows.length === 0) return;
    const contributions = await buildCreditContributions(client, rows);
    await applyCreditBatch(client, rows, contributions, state, details, phase);
    cursor = details[`${phase}Cursor`];
    console.log(
      `[credit_usage] ${phase} 已处理到 ${cursor.createdAt}/${cursor.id}`
    );
  }
}

/**
 * 在任何 legacy context 写入前完成全量证据预检。
 *
 * 预检按消费后退款的固定顺序读取 snapshot high-water，只解析和核对，不修改数据库。
 * 未知消费、editable/relay 缺时点、退款 batch 冲突或孤立退款会在部分回填前阻断。
 */
async function preflightCreditEvidence(client, highWater, batchSize) {
  for (const transactionType of ["consumption", "refund"]) {
    let cursor = null;
    while (true) {
      const rows = await readCreditBatch(
        client,
        cursor,
        highWater?.[transactionType] ?? null,
        batchSize,
        transactionType
      );
      if (rows.length === 0) break;
      await buildCreditContributions(client, rows);
      cursor = {
        createdAt: rows.at(-1).createdAt,
        id: rows.at(-1).id,
      };
    }
  }
  console.log("[credit_usage] 历史 operation context 证据预检通过");
}

/** 对账权威输出任务、事件和累计汇总。 */
async function reconcileOutputUsage(client) {
  const result = await client.query(buildOutputUsageReconciliationSql());
  const row = result.rows[0];
  return {
    insufficientImageEvidence: databaseNumber(
      row.insufficient_image_evidence,
      "output.insufficient_image_evidence"
    ),
    invalidCompletedVideos: databaseNumber(
      row.invalid_completed_videos,
      "output.invalid_completed_videos"
    ),
    eventDifference: databaseNumber(
      row.event_difference,
      "output.event_difference"
    ),
    summaryDifference: databaseNumber(
      row.summary_difference,
      "output.summary_difference"
    ),
  };
}

/** 对账账本、唯一贡献、操作 gross/refund/net 与账户累计字段。 */
async function reconcileCreditUsage(client) {
  const result = await client.query(
    `WITH ledger AS (
       SELECT id, user_id, type, amount, operation_type, operation_id,
              operation_created_at, created_at
         FROM credits_transaction
        WHERE type IN ('consumption', 'refund')
     ), projection_difference AS (
       SELECT count(*)::integer AS count
         FROM ledger
         FULL JOIN credit_usage_projection_entry projected
           ON projected.transaction_id = ledger.id
        WHERE ledger.id IS NULL
           OR projected.transaction_id IS NULL
           OR projected.user_id IS DISTINCT FROM ledger.user_id
           OR projected.contribution_kind::text IS DISTINCT FROM ledger.type::text
           OR projected.amount IS DISTINCT FROM ledger.amount
           OR projected.operation_type IS DISTINCT FROM ledger.operation_type
           OR projected.operation_id IS DISTINCT FROM ledger.operation_id
           OR projected.operation_created_at
              IS DISTINCT FROM ledger.operation_created_at
           OR projected.transaction_created_at IS DISTINCT FROM ledger.created_at
     ), expected_operation AS (
       SELECT user_id, operation_type, operation_id,
              min(operation_created_at) AS operation_created_at,
              count(DISTINCT operation_created_at) AS created_at_count,
              coalesce(sum(amount) FILTER (WHERE type = 'consumption'), 0)
                AS gross_consumed,
              coalesce(sum(amount) FILTER (WHERE type = 'refund'), 0)
                AS refunded
         FROM ledger
        GROUP BY user_id, operation_type, operation_id
     ), operation_difference AS (
       SELECT count(*)::integer AS count
         FROM expected_operation expected
         FULL JOIN credit_usage_operation actual
           ON actual.user_id = expected.user_id
          AND actual.operation_type = expected.operation_type
          AND actual.operation_id = expected.operation_id
        WHERE expected.user_id IS NULL
           OR actual.user_id IS NULL
           OR expected.created_at_count <> 1
           OR actual.operation_created_at
              IS DISTINCT FROM expected.operation_created_at
           OR actual.gross_consumed IS DISTINCT FROM expected.gross_consumed
           OR actual.refunded IS DISTINCT FROM expected.refunded
           OR actual.net_consumed
              IS DISTINCT FROM expected.gross_consumed - expected.refunded
     ), expected_balance AS (
       SELECT user_id,
              coalesce(sum(amount) FILTER (WHERE type = 'consumption'), 0)
                AS total_spent,
              coalesce(sum(amount) FILTER (WHERE type = 'refund'), 0)
                AS total_refunded
         FROM ledger
        GROUP BY user_id
     ), balance_difference AS (
       SELECT count(*)::integer AS count
         FROM expected_balance expected
         FULL JOIN credits_balance actual USING (user_id)
        WHERE actual.user_id IS NULL
           OR actual.total_spent
              IS DISTINCT FROM coalesce(expected.total_spent, 0)
           OR actual.total_refunded
              IS DISTINCT FROM coalesce(expected.total_refunded, 0)
     ), refund_temporal_violation AS (
       SELECT count(*)::integer AS count
         FROM expected_operation operation
         JOIN LATERAL (
           SELECT min(created_at) FILTER (WHERE type = 'consumption')
                    AS first_consumption_at,
                  min(created_at) FILTER (WHERE type = 'refund')
                    AS first_refund_at
             FROM ledger
            WHERE ledger.user_id = operation.user_id
              AND ledger.operation_type = operation.operation_type
              AND ledger.operation_id = operation.operation_id
         ) timing ON true
        WHERE timing.first_refund_at IS NOT NULL
          AND (
            timing.first_consumption_at IS NULL
            OR timing.first_refund_at < timing.first_consumption_at
          )
     )
     SELECT
       (SELECT count(*)::integer FROM ledger
         WHERE operation_type IS NULL
            OR operation_id IS NULL
            OR operation_created_at IS NULL) AS missing_ledger_context,
       (SELECT count FROM projection_difference) AS projection_difference,
       (SELECT count FROM operation_difference) AS operation_difference,
       (SELECT count FROM balance_difference) AS balance_difference,
       (SELECT count FROM refund_temporal_violation)
         AS refund_temporal_violation,
       (SELECT count(*)::integer FROM expected_operation
         WHERE refunded > gross_consumed) AS negative_net_operation`
  );
  const row = result.rows[0];
  return {
    missingLedgerContext: databaseNumber(
      row.missing_ledger_context,
      "credit.missing_ledger_context"
    ),
    projectionDifference: databaseNumber(
      row.projection_difference,
      "credit.projection_difference"
    ),
    operationDifference: databaseNumber(
      row.operation_difference,
      "credit.operation_difference"
    ),
    balanceDifference: databaseNumber(
      row.balance_difference,
      "credit.balance_difference"
    ),
    refundTemporalViolation: databaseNumber(
      row.refund_temporal_violation,
      "credit.refund_temporal_violation"
    ),
    negativeNetOperation: databaseNumber(
      row.negative_net_operation,
      "credit.negative_net_operation"
    ),
  };
}

/** 把对账结果写为 ready；任一非零差异都由调用方先阻断。 */
async function markReadModelReady(client, readModel, state, details, result) {
  const reconciledAt = new Date().toISOString();
  const readyDetails = {
    ...copyDetails(details),
    phase: "ready",
    reconciliation: result,
    lastFailure: null,
  };
  await writeReadModelState(client, readModel, {
    status: "ready",
    snapshotHighWater: state.snapshotHighWater,
    catchUpWater: state.catchUpWater,
    details: readyDetails,
    lastReconciledAt: reconciledAt,
  });
}

/** 在运维可见状态中记录失败，但不记录连接串、SQL 参数或用户内容。 */
async function markReadModelFailed(client, readModel, error) {
  const state = await ensureReadModelState(client, readModel);
  const details = copyDetails(state.details);
  details.lastFailure = {
    message: error instanceof Error ? error.message : "未知回填错误",
    failedAt: new Date().toISOString(),
  };
  await writeReadModelState(client, readModel, {
    status: "failed",
    snapshotHighWater: state.snapshot_high_water,
    catchUpWater: state.catch_up_water,
    details,
    lastReconciledAt: null,
  });
}

/** 将错误归类为财务/证据门禁失败，供命令入口选择稳定退出码。 */
function isDataIntegrityFailure(error) {
  const message = error instanceof Error ? error.message : "";
  return /证据|sourceRef|operation|退款|账本|对账|贡献|毛消费|白名单|金额/.test(
    message
  );
}

/** 初始化或恢复一个模型的 snapshot/catch-up 状态。 */
async function prepareBackfillState(
  client,
  readModel,
  readHighWater,
  initialPhase = "snapshot"
) {
  const stored = await ensureReadModelState(client, readModel);
  const storedDetails = copyDetails(stored.details);
  const canResume =
    stored.version === READ_MODEL_VERSION &&
    stored.snapshot_high_water &&
    typeof storedDetails.phase === "string" &&
    storedDetails.phase !== "ready";
  if (canResume && stored.status !== "failed") {
    return {
      snapshotHighWater: stored.snapshot_high_water,
      catchUpWater: stored.catch_up_water,
      details: storedDetails,
    };
  }

  const snapshotHighWater = await readHighWater(client);
  const details = {
    phase: initialPhase,
    snapshotCursor: null,
    catchUpCursor: null,
    processedRows: 0,
    lastFailure: null,
  };
  await writeReadModelState(client, readModel, {
    status: "backfilling",
    snapshotHighWater,
    catchUpWater: null,
    details,
    lastReconciledAt: null,
  });
  return { snapshotHighWater, catchUpWater: null, details };
}

/** 执行 output_usage 的恢复、双 pass 与最终对账。 */
async function runOutputUsage(client, options) {
  const state = await prepareBackfillState(
    client,
    "output_usage",
    readOutputHighWater
  );
  const details = state.details;
  if (!options.reconcileOnly && details.phase === "snapshot") {
    await runOutputPass(
      client,
      state,
      details,
      "snapshot",
      state.snapshotHighWater,
      options.batchSize
    );
    state.catchUpWater = await readOutputHighWater(client);
    details.phase = "catchUp";
    details.catchUpCursor = state.snapshotHighWater;
    await writeReadModelState(client, "output_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details,
      lastReconciledAt: null,
    });
  }
  if (!options.reconcileOnly && details.phase === "catchUp") {
    await runOutputPass(
      client,
      state,
      details,
      "catchUp",
      state.catchUpWater,
      options.batchSize
    );
  }
  details.phase = "reconciling";
  await writeReadModelState(client, "output_usage", {
    status: "reconciling",
    snapshotHighWater: state.snapshotHighWater,
    catchUpWater: state.catchUpWater,
    details,
    lastReconciledAt: null,
  });
  await inTransaction(client, async () => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const reconciliation = await reconcileOutputUsage(client);
    if (hasReconciliationDifference(reconciliation)) {
      throw new Error(
        `output_usage 对账存在差异：${JSON.stringify(reconciliation)}`
      );
    }
    await markReadModelReady(
      client,
      "output_usage",
      state,
      details,
      reconciliation
    );
  });
  console.log("[output_usage] 回填与对账完成，状态已切换为 ready");
}

/** 执行 credit_usage 的恢复、双 pass 与最终对账。 */
async function runCreditUsage(client, options) {
  const state = await prepareBackfillState(
    client,
    "credit_usage",
    async (database) => ({
      consumption: await readCreditHighWater(database, "consumption"),
      refund: await readCreditHighWater(database, "refund"),
    }),
    "snapshotConsumption"
  );
  const details = state.details;
  if (!options.reconcileOnly && details.preflightCompleted !== true) {
    await preflightCreditEvidence(
      client,
      state.snapshotHighWater,
      options.batchSize
    );
    details.preflightCompleted = true;
    await writeReadModelState(client, "credit_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details,
      lastReconciledAt: null,
    });
  }
  if (!options.reconcileOnly && details.phase === "snapshotConsumption") {
    await runCreditPass(
      client,
      state,
      details,
      "snapshotConsumption",
      state.snapshotHighWater?.consumption ?? null,
      options.batchSize,
      "consumption"
    );
    details.phase = "snapshotRefund";
    await writeReadModelState(client, "credit_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: null,
      details,
      lastReconciledAt: null,
    });
  }
  if (!options.reconcileOnly && details.phase === "snapshotRefund") {
    await runCreditPass(
      client,
      state,
      details,
      "snapshotRefund",
      state.snapshotHighWater?.refund ?? null,
      options.batchSize,
      "refund"
    );
    state.catchUpWater = {
      consumption: await readCreditHighWater(client, "consumption"),
      refund: await readCreditHighWater(client, "refund"),
    };
    details.phase = "catchUpConsumption";
    details.catchUpConsumptionCursor =
      state.snapshotHighWater?.consumption ?? null;
    details.catchUpRefundCursor = state.snapshotHighWater?.refund ?? null;
    await writeReadModelState(client, "credit_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details,
      lastReconciledAt: null,
    });
  }
  if (!options.reconcileOnly && details.phase === "catchUpConsumption") {
    await runCreditPass(
      client,
      state,
      details,
      "catchUpConsumption",
      state.catchUpWater?.consumption ?? null,
      options.batchSize,
      "consumption"
    );
    details.phase = "catchUpRefund";
    await writeReadModelState(client, "credit_usage", {
      status: "backfilling",
      snapshotHighWater: state.snapshotHighWater,
      catchUpWater: state.catchUpWater,
      details,
      lastReconciledAt: null,
    });
  }
  if (!options.reconcileOnly && details.phase === "catchUpRefund") {
    await runCreditPass(
      client,
      state,
      details,
      "catchUpRefund",
      state.catchUpWater?.refund ?? null,
      options.batchSize,
      "refund"
    );
  }
  details.phase = "reconciling";
  await writeReadModelState(client, "credit_usage", {
    status: "reconciling",
    snapshotHighWater: state.snapshotHighWater,
    catchUpWater: state.catchUpWater,
    details,
    lastReconciledAt: null,
  });
  await inTransaction(client, async () => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const reconciliation = await reconcileCreditUsage(client);
    if (hasReconciliationDifference(reconciliation)) {
      throw new Error(
        `credit_usage 对账存在差异：${JSON.stringify(reconciliation)}`
      );
    }
    await markReadModelReady(
      client,
      "credit_usage",
      state,
      details,
      reconciliation
    );
  });
  console.log("[credit_usage] 回填与对账完成，状态已切换为 ready");
}

/** 运行用户选择的模型，并在失败模型上持久化可恢复状态。 */
async function runSelectedModels(client, options) {
  const models =
    options.model === "all" ? ["output", "credit"] : [options.model];
  for (const model of models) {
    const readModel = model === "output" ? "output_usage" : "credit_usage";
    try {
      if (options.skipReady) {
        const stored = await ensureReadModelState(client, readModel);
        if (
          stored.version === READ_MODEL_VERSION &&
          stored.status === "ready"
        ) {
          console.log(`[${readModel}] 当前版本已 ready，跳过重复全量回填`);
          continue;
        }
      }
      if (model === "output") {
        await runOutputUsage(client, options);
      } else {
        await runCreditUsage(client, options);
      }
    } catch (error) {
      await markReadModelFailed(client, readModel, error);
      throw error;
    }
  }
}

/**
 * 命令入口：加载连接、获取单实例 advisory lock、执行回填并关闭连接。
 *
 * @returns 成功时无返回；失败由直接执行保护转成非零退出码。
 * @sideEffects 连接 PostgreSQL 并分批写入读模型、账本 context 与状态表。
 */
export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseBackfillOptions(argumentsList);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL 环境变量未设置");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let lockAcquired = false;
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [BACKFILL_LOCK_NAME]
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      const lockError = new Error("已有控制台统计回填任务正在运行");
      lockError.code = "BACKFILL_LOCKED";
      throw lockError;
    }
    await runSelectedModels(client, options);
  } finally {
    if (lockAcquired) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [
        BACKFILL_LOCK_NAME,
      ]);
    }
    await client.end();
  }
}

const executedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (executedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "未知回填错误");
    process.exitCode =
      error?.code === "BACKFILL_LOCKED"
        ? 4
        : isDataIntegrityFailure(error)
          ? 3
          : 1;
  });
}
