/**
 * 控制台统计回填器的纯解析与证据判定核心。
 *
 * 数据库编排脚本与 DB-free 测试共同使用本模块。这里不访问数据库、不读取环境变量，
 * 只负责参数校验、图片产物证据和历史积分账本的 operation context 归属。
 */

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;
const VALID_MODELS = new Set(["all", "output", "credit"]);

/** 将未知值收窄为普通 JSON 对象。 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/** 读取并规范化非空字符串；非法值返回 null。 */
function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 构造用户内唯一的计费操作键。 */
export function creditOperationKey(userId, operationType, operationId) {
  return JSON.stringify([userId, operationType, operationId]);
}

/**
 * 解析回填命令参数。
 *
 * @param {string[]} argumentsList `process.argv.slice(2)`。
 * @returns {{ model: "all" | "output" | "credit", batchSize: number, reconcileOnly: boolean, skipReady: boolean }}
 * @throws 参数未知、重复、越界或格式非法时抛出 RangeError；无副作用。
 */
export function parseBackfillOptions(argumentsList) {
  let model = "all";
  let batchSize = DEFAULT_BATCH_SIZE;
  let reconcileOnly = false;
  let skipReady = false;
  const seen = new Set();

  for (const argument of argumentsList) {
    if (argument === "--") continue;
    if (argument === "--reconcile-only") {
      if (seen.has("reconcileOnly")) {
        throw new RangeError("--reconcile-only 不能重复传入");
      }
      seen.add("reconcileOnly");
      reconcileOnly = true;
      continue;
    }
    if (argument === "--skip-ready") {
      if (seen.has("skipReady")) {
        throw new RangeError("--skip-ready 不能重复传入");
      }
      seen.add("skipReady");
      skipReady = true;
      continue;
    }
    if (argument.startsWith("--model=")) {
      if (seen.has("model")) {
        throw new RangeError("--model 不能重复传入");
      }
      seen.add("model");
      model = argument.slice("--model=".length);
      if (!VALID_MODELS.has(model)) {
        throw new RangeError("--model 只支持 all、output 或 credit");
      }
      continue;
    }
    if (argument.startsWith("--batch-size=")) {
      if (seen.has("batchSize")) {
        throw new RangeError("--batch-size 不能重复传入");
      }
      seen.add("batchSize");
      const parsed = Number(argument.slice("--batch-size=".length));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_BATCH_SIZE) {
        throw new RangeError(
          `--batch-size 必须是 1 到 ${MAX_BATCH_SIZE} 的整数`
        );
      }
      batchSize = parsed;
      continue;
    }
    throw new RangeError(`未知参数：${argument}`);
  }

  return { model, batchSize, reconcileOnly, skipReady };
}

/**
 * 按在线双写相同优先级解析历史图片产物数量。
 *
 * @param {{ status: string, storageKey?: string | null, metadata?: unknown }} row
 * @returns {{ status: "counted", count: number } | { status: "notCounted", count: 0 } | { status: "insufficientEvidence", count: null }}
 * @throws 不抛异常；非法 metadata 按无证据处理。
 */
export function resolveBackfillImageOutputCount(row) {
  if (row.status !== "completed") {
    return { status: "notCounted", count: 0 };
  }
  const metadata = asRecord(row.metadata);
  const outputImage = asRecord(metadata?.outputImage);
  const billableCount = outputImage?.billableImageOutputCount;
  if (typeof billableCount === "number" && Number.isFinite(billableCount)) {
    if (!Number.isInteger(billableCount) || billableCount <= 0) {
      return { status: "notCounted", count: 0 };
    }
    return { status: "counted", count: billableCount };
  }
  if (nonemptyString(row.storageKey)) {
    return { status: "counted", count: 1 };
  }
  if (asRecord(outputImage?.photoRetention)) {
    return { status: "counted", count: 1 };
  }
  if (asRecord(metadata?.chatTextOnlyCharge)) {
    return { status: "notCounted", count: 0 };
  }
  return { status: "insufficientEvidence", count: null };
}

/**
 * 构造成功产物事实与累计汇总的对账 SQL。
 *
 * WHY：画廊删除只删除展示记录和存储对象，已经发生的用量不能随之消失。因此
 * `user_output_usage_event` 在首次事务写入后是持久事实；仍存在的任务必须能在事件表中
 * 找到一致记录，但事件不要求反向找到可被用户删除的 generation。累计汇总始终从事件
 * 事实重算，才能同时覆盖在库任务与已删除画廊任务。
 *
 * @returns 可直接交给 pg Client 执行的单条只读 SQL。
 * @sideEffects 无副作用。
 */
export function buildOutputUsageReconciliationSql() {
  return `WITH image_source AS (
       SELECT id, user_id, created_at, storage_key, metadata::jsonb AS metadata,
              metadata::jsonb #> '{outputImage,billableImageOutputCount}'
                AS billable_value
         FROM generation
        WHERE status = 'completed'
     ), image_classified AS (
       SELECT *,
              CASE
                WHEN jsonb_typeof(billable_value) = 'number' THEN
                  CASE WHEN (billable_value #>> '{}')::numeric > 0
                             AND (billable_value #>> '{}')::numeric
                                 = trunc((billable_value #>> '{}')::numeric)
                       THEN (billable_value #>> '{}')::integer
                       ELSE 0 END
                WHEN nullif(btrim(storage_key), '') IS NOT NULL THEN 1
                WHEN jsonb_typeof(metadata #> '{outputImage,photoRetention}')
                     = 'object' THEN 1
                WHEN jsonb_typeof(metadata -> 'chatTextOnlyCharge')
                     = 'object' THEN 0
                ELSE NULL
              END AS image_count
         FROM image_source
     ), expected AS (
       SELECT 'image'::output_usage_kind AS output_kind,
              id AS source_task_id, user_id,
              created_at AS operation_created_at,
              image_count, 0::integer AS video_seconds
         FROM image_classified
        WHERE image_count > 0
       UNION ALL
       SELECT 'video'::output_usage_kind, id, user_id, created_at,
              0::integer, duration_seconds
         FROM video_generation
        WHERE status = 'completed'
          AND duration_seconds > 0
     ), event_difference AS (
       SELECT count(*)::integer AS count
         FROM expected
         LEFT JOIN user_output_usage_event actual
           ON actual.output_kind = expected.output_kind
          AND actual.source_task_id = expected.source_task_id
        WHERE actual.source_task_id IS NULL
           OR actual.user_id IS DISTINCT FROM expected.user_id
           OR actual.operation_created_at
              IS DISTINCT FROM expected.operation_created_at
           OR actual.image_count IS DISTINCT FROM expected.image_count
           OR actual.video_seconds IS DISTINCT FROM expected.video_seconds
     ), expected_summary AS (
       SELECT user_id,
              sum(image_count)::bigint AS total_image_count,
              sum(video_seconds)::bigint AS total_video_seconds
         FROM user_output_usage_event
        GROUP BY user_id
     ), summary_difference AS (
       SELECT count(*)::integer AS count
         FROM expected_summary expected
         FULL JOIN user_usage_summary actual USING (user_id)
        WHERE expected.user_id IS NULL
           OR actual.user_id IS NULL
           OR actual.total_image_count
              IS DISTINCT FROM expected.total_image_count
           OR actual.total_video_seconds
              IS DISTINCT FROM expected.total_video_seconds
     )
     SELECT
       (SELECT count(*)::integer FROM image_classified WHERE image_count IS NULL)
         AS insufficient_image_evidence,
       (SELECT count(*)::integer FROM video_generation
         WHERE status = 'completed'
           AND duration_seconds <= 0)
         AS invalid_completed_videos,
       (SELECT count FROM event_difference) AS event_difference,
       (SELECT count FROM summary_difference) AS summary_difference`;
}

/** 校验同一 operation key 的创建时间保持唯一，并写入当前批次缓存。 */
function rememberOperationContext(context, evidence) {
  const key = creditOperationKey(
    context.userId,
    context.operationType,
    context.operationId
  );
  const existing = evidence.operationCreatedAtByKey.get(key);
  if (existing && existing !== context.operationCreatedAt) {
    throw new Error(
      `计费操作创建时间冲突：${context.operationType}/${context.operationId}`
    );
  }
  evidence.operationCreatedAtByKey.set(key, context.operationCreatedAt);
  return {
    operationType: context.operationType,
    operationId: context.operationId,
    operationCreatedAt: context.operationCreatedAt,
  };
}

/** 从权威任务/不可变产物事件或已处理操作缓存读取创建时间。 */
function resolveKnownOperationCreatedAt(params, evidence) {
  const taskCreatedAt = params.taskCreatedAt;
  const key = creditOperationKey(
    params.userId,
    params.operationType,
    params.operationId
  );
  const projectedCreatedAt = evidence.operationCreatedAtByKey.get(key);
  if (
    taskCreatedAt &&
    projectedCreatedAt &&
    taskCreatedAt !== projectedCreatedAt
  ) {
    throw new Error(
      `权威任务与计费操作创建时间冲突：${params.operationType}/${params.operationId}`
    );
  }
  return taskCreatedAt ?? projectedCreatedAt ?? null;
}

/** 判断账本 operation 三列是全空、全有还是部分缺失。 */
function storedOperationShape(row) {
  const values = [row.operationType, row.operationId, row.operationCreatedAt];
  const present = values.filter((value) => value !== null).length;
  if (present === 0) return "empty";
  if (present === values.length) return "complete";
  return "partial";
}

/** 为无业务任务的历史消费选择受控 ledger fallback 类型。 */
function resolveLedgerFallbackType(metadata) {
  if (
    metadata?.serviceName === "admin_credit_adjustment" &&
    nonemptyString(metadata?.adminUserId)
  ) {
    return "admin_credit_adjustment";
  }
  if (nonemptyString(metadata?.serviceName)) {
    return "manual_consumption";
  }
  return null;
}

/** 把完整已存 context 绑定回权威任务或受控 fallback，禁止只验证内部自洽。 */
function verifyStoredOperationContext(row, evidence, context, metadata) {
  if (
    context.operationType === "image_generation" ||
    context.operationType === "video_generation"
  ) {
    if (
      context.operationType === "image_generation" &&
      row.type === "consumption" &&
      metadata?.blockRepair === true &&
      Number.isInteger(metadata.index)
    ) {
      const sourceRef = nonemptyString(row.sourceRef);
      const suffix = `:blockrepair-${metadata.index}`;
      const outputGenerationId = sourceRef?.endsWith(suffix)
        ? sourceRef.slice(0, -suffix.length)
        : null;
      const parent = outputGenerationId
        ? evidence.blockRepairParentByOutputKey?.get(
            creditOperationKey(row.userId, "output", outputGenerationId)
          )
        : null;
      if (
        !parent ||
        parent.generationId !== context.operationId ||
        parent.createdAt !== context.operationCreatedAt
      ) {
        throw new Error(`账本 ${row.id} 的生成式修复 operation 证据不一致`);
      }
      return;
    }
    const taskKey = creditOperationKey(row.userId, "task", context.operationId);
    const taskCreatedAt =
      context.operationType === "image_generation"
        ? evidence.imageCreatedAtByKey.get(taskKey)
        : evidence.videoCreatedAtByKey.get(taskKey);
    if (!taskCreatedAt || taskCreatedAt !== context.operationCreatedAt) {
      throw new Error(
        `账本 ${row.id} 的 operation context 与任务或产物事件不一致`
      );
    }
    const sourceRef =
      nonemptyString(row.sourceRef) ?? nonemptyString(metadata?.sourceRef);
    const metadataGenerationId = nonemptyString(metadata?.generationId);
    const metadataVideoId = nonemptyString(metadata?.videoGenerationId);
    const sourceMatches =
      context.operationType === "image_generation"
        ? row.type === "consumption"
          ? isAllowedImageSourceRef(context.operationId, sourceRef)
          : isAllowedImageRefundSourceRef(context.operationId, sourceRef)
        : sourceRef === `adobe-video:${context.operationId}`;
    const metadataMatches =
      row.type === "refund"
        ? metadataGenerationId === context.operationId
        : context.operationType === "image_generation"
          ? metadataGenerationId === context.operationId
          : (metadataVideoId ?? metadataGenerationId) === context.operationId;
    if (!sourceMatches || !metadataMatches) {
      throw new Error(`账本 ${row.id} 的 operation context 任务证据不一致`);
    }
    return;
  }

  if (
    context.operationType === "editable_file_ppt" ||
    context.operationType === "editable_file_psd"
  ) {
    const kind = context.operationType.endsWith("_ppt") ? "ppt" : "psd";
    const metadataTaskId = nonemptyString(metadata?.taskId);
    if (
      row.type !== "consumption" ||
      metadata?.kind !== kind ||
      metadataTaskId !== context.operationId ||
      nonemptyString(row.sourceRef) !==
        `editable-file:${context.operationId}` ||
      row.debitAccount !== `WALLET:${row.userId}` ||
      row.creditAccount !== `SERVICE:editable_file_${kind}`
    ) {
      throw new Error(`账本 ${row.id} 的可编辑文件 operation 证据不一致`);
    }
    return;
  }

  const fallbackType =
    context.operationType === "uol_credit_consumption" &&
    nonemptyString(row.sourceRef) &&
    nonemptyString(metadata?.serviceName)
      ? "uol_credit_consumption"
      : resolveLedgerFallbackType(metadata);
  const accountMatches =
    row.debitAccount === `WALLET:${row.userId}` &&
    row.creditAccount === `SERVICE:${metadata.serviceName}`;
  if (
    row.type !== "consumption" ||
    context.operationType !== fallbackType ||
    context.operationId !== row.id ||
    context.operationCreatedAt !== row.createdAt ||
    !accountMatches
  ) {
    throw new Error(`账本 ${row.id} 的 operation context 缺少权威证据`);
  }
}

/** 校验普通图片账本的完整 sourceRef 白名单，不做末段截取。 */
function isAllowedImageSourceRef(generationId, sourceRef) {
  if (!sourceRef) return false;
  const allowedSuffixes = [
    "moderation",
    "generation-exception",
    "generation-error",
    "missing-image-output",
    "chat-text-only",
    "storage-error",
    "image-actual-size",
    "settlement-error",
  ];
  if (sourceRef === `${generationId}:charge`) return true;
  return allowedSuffixes.some(
    (suffix) => sourceRef === `${generationId}:${suffix}:charge`
  );
}

/** 校验图片退款的完整 sourceRef 白名单。 */
function isAllowedImageRefundSourceRef(generationId, sourceRef) {
  if (!sourceRef) return false;
  const allowedSuffixes = [
    "moderation",
    "generation-exception",
    "generation-error",
    "missing-image-output",
    "chat-text-only",
    "storage-error",
    "image-actual-size",
    "settlement-error",
    "timeout-refund",
  ];
  return allowedSuffixes.some(
    (suffix) => sourceRef === `${generationId}:${suffix}`
  );
}

/**
 * 用可验证证据解析一条历史消费或退款的 operation context。
 *
 * @param {object} row 账本行；时间字段必须是数据库规范化字符串。
 * @param {object} evidence generation/video 或不可变产物事件时间映射及操作映射。
 * @returns {{ operationType: string, operationId: string, operationCreatedAt: string }}
 * @throws 部分 context、任务归属冲突、孤立退款或缺少证据时抛出；不修改账本。
 */
export function resolveBackfillCreditOperation(row, evidence) {
  if (row.type !== "consumption" && row.type !== "refund") {
    throw new Error(`不支持的积分贡献类型：${row.type}`);
  }
  const amount = Number(row.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`账本 ${row.id} 的积分金额必须为正数`);
  }
  const shape = storedOperationShape(row);
  if (shape === "partial") {
    throw new Error(`账本 ${row.id} 的 operation context 字段不完整`);
  }
  if (shape === "complete") {
    const operationType = nonemptyString(row.operationType);
    const operationId = nonemptyString(row.operationId);
    const operationCreatedAt = nonemptyString(row.operationCreatedAt);
    if (!operationType || !operationId || !operationCreatedAt) {
      throw new Error(`账本 ${row.id} 的 operation context 包含空白值`);
    }
    const context = {
      userId: row.userId,
      operationType,
      operationId,
      operationCreatedAt,
    };
    verifyStoredOperationContext(
      row,
      evidence,
      context,
      asRecord(row.metadata) ?? {}
    );
    return rememberOperationContext(context, evidence);
  }

  const metadata = asRecord(row.metadata) ?? {};
  const generationId = nonemptyString(metadata.generationId);
  const videoGenerationId = nonemptyString(metadata.videoGenerationId);
  const editableTaskId = nonemptyString(metadata.taskId);
  const editableKind =
    metadata.kind === "ppt" || metadata.kind === "psd" ? metadata.kind : null;
  const sourceRef = nonemptyString(row.sourceRef);
  const metadataSourceRef = nonemptyString(metadata.sourceRef);

  if (row.type === "consumption" && videoGenerationId) {
    const taskKey = creditOperationKey(row.userId, "task", videoGenerationId);
    const taskCreatedAt = evidence.videoCreatedAtByKey.get(taskKey);
    if (!taskCreatedAt) {
      throw new Error(`视频消费 ${row.id} 找不到权威 video_generation 行`);
    }
    if (sourceRef !== `adobe-video:${videoGenerationId}`) {
      throw new Error(`视频消费 ${row.id} 的 sourceRef 不符合完整任务格式`);
    }
    const operationType = "video_generation";
    const operationCreatedAt = resolveKnownOperationCreatedAt(
      {
        userId: row.userId,
        operationType,
        operationId: videoGenerationId,
        taskCreatedAt,
      },
      evidence
    );
    return rememberOperationContext(
      {
        userId: row.userId,
        operationType,
        operationId: videoGenerationId,
        operationCreatedAt,
      },
      evidence
    );
  }

  if (row.type === "consumption" && generationId) {
    const taskKey = creditOperationKey(row.userId, "task", generationId);
    const imageCreatedAt = evidence.imageCreatedAtByKey.get(taskKey);
    const videoCreatedAt = evidence.videoCreatedAtByKey.get(taskKey);
    if (imageCreatedAt && videoCreatedAt) {
      throw new Error(`消费 ${row.id} 同时命中图片和视频权威任务`);
    }
    if (!imageCreatedAt && !videoCreatedAt) {
      throw new Error(`图片消费 ${row.id} 找不到权威 generation 行`);
    }
    if (imageCreatedAt && !isAllowedImageSourceRef(generationId, sourceRef)) {
      throw new Error(`图片消费 ${row.id} 的 sourceRef 不符合完整任务格式`);
    }
    if (videoCreatedAt && sourceRef !== `adobe-video:${generationId}`) {
      throw new Error(`视频消费 ${row.id} 的 sourceRef 不符合完整任务格式`);
    }
    const operationType = videoCreatedAt
      ? "video_generation"
      : "image_generation";
    const operationCreatedAt = resolveKnownOperationCreatedAt(
      {
        userId: row.userId,
        operationType,
        operationId: generationId,
        taskCreatedAt: imageCreatedAt ?? videoCreatedAt ?? null,
      },
      evidence
    );
    return rememberOperationContext(
      {
        userId: row.userId,
        operationType,
        operationId: generationId,
        operationCreatedAt,
      },
      evidence
    );
  }

  if (row.type === "consumption" && metadata.blockRepair === true) {
    if (!sourceRef || !Number.isInteger(metadata.index)) {
      throw new Error(`生成式修复消费 ${row.id} 缺少完整 sourceRef 或 index`);
    }
    const outputGenerationId = sourceRef.slice(
      0,
      -`:blockrepair-${metadata.index}`.length
    );
    if (
      !outputGenerationId ||
      sourceRef !== `${outputGenerationId}:blockrepair-${metadata.index}`
    ) {
      throw new Error(`生成式修复消费 ${row.id} 的 sourceRef 格式非法`);
    }
    const parent = evidence.blockRepairParentByOutputKey?.get(
      creditOperationKey(row.userId, "output", outputGenerationId)
    );
    if (!parent) {
      throw new Error(`生成式修复消费 ${row.id} 无法唯一关联父 generation`);
    }
    return rememberOperationContext(
      {
        userId: row.userId,
        operationType: "image_generation",
        operationId: parent.generationId,
        operationCreatedAt: parent.createdAt,
      },
      evidence
    );
  }

  if (row.type === "consumption" && editableTaskId && editableKind) {
    throw new Error(
      `可编辑文件消费 ${row.id} 缺少权威任务创建时间，禁止按扣费时间猜测`
    );
  }

  if (row.type === "consumption") {
    const operationType = resolveLedgerFallbackType(metadata);
    const accountMatches =
      row.debitAccount === `WALLET:${row.userId}` &&
      row.creditAccount === `SERVICE:${metadata.serviceName}`;
    if (!operationType || !accountMatches) {
      throw new Error(`消费 ${row.id} 不符合受控 ledger fallback 白名单`);
    }
    return rememberOperationContext(
      {
        userId: row.userId,
        operationType,
        operationId: row.id,
        operationCreatedAt: row.createdAt,
      },
      evidence
    );
  }

  if (!generationId) {
    throw new Error(`退款 ${row.id} 缺少原任务 generationId 证据`);
  }
  const taskKey = creditOperationKey(row.userId, "task", generationId);
  const imageCreatedAt = evidence.imageCreatedAtByKey.get(taskKey);
  const videoCreatedAt = evidence.videoCreatedAtByKey.get(taskKey);
  if (imageCreatedAt && videoCreatedAt) {
    throw new Error(`退款 ${row.id} 同时命中图片和视频权威任务`);
  }
  const candidates = [];
  if (imageCreatedAt) {
    candidates.push({
      operationType: "image_generation",
      operationCreatedAt: imageCreatedAt,
    });
  }
  if (videoCreatedAt) {
    candidates.push({
      operationType: "video_generation",
      operationCreatedAt: videoCreatedAt,
    });
  }
  if (candidates.length === 0) {
    for (const operationType of ["image_generation", "video_generation"]) {
      const key = creditOperationKey(row.userId, operationType, generationId);
      const operationCreatedAt = evidence.operationCreatedAtByKey.get(key);
      if (operationCreatedAt) {
        candidates.push({ operationType, operationCreatedAt });
      }
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`退款 ${row.id} 无法唯一关联原计费操作`);
  }
  const refundSourceRef = sourceRef ?? metadataSourceRef;
  if (
    (candidates[0].operationType === "image_generation" &&
      !isAllowedImageRefundSourceRef(generationId, refundSourceRef)) ||
    (candidates[0].operationType === "video_generation" &&
      refundSourceRef !== `adobe-video:${generationId}`)
  ) {
    throw new Error(`退款 ${row.id} 的 sourceRef 不符合原任务完整格式`);
  }
  return rememberOperationContext(
    {
      userId: row.userId,
      operationType: candidates[0].operationType,
      operationId: generationId,
      operationCreatedAt: candidates[0].operationCreatedAt,
    },
    evidence
  );
}

/** 判断对账结果是否所有差异项都为零。 */
export function hasReconciliationDifference(result) {
  return Object.entries(result).some(([field, value]) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`对账字段 ${field} 不是有限数值`);
    }
    return parsed !== 0;
  });
}
