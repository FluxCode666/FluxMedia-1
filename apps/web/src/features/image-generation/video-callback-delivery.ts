/**
 * 视频终态回调的持久化投递 worker。
 *
 * 职责：生成独立回调记录、用 PostgreSQL SKIP LOCKED 原子认领终态任务、逐跳复检
 * callback URL，并以稳定幂等键执行有限退避重试。使用方是视频 UOL binding、视频
 * 创建事务与内置恢复任务。
 */

import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import {
  videoGeneration,
  videoGenerationCallbackDelivery,
} from "@repo/database/schema";
import { videoInputManifestSchema } from "@repo/shared/image-generation/media-contract";
import { logError } from "@repo/shared/logger";
import { buildPublicImageUrl } from "@repo/shared/storage/signed-url";
import { getRuntimeSettingString } from "@repo/shared/system-settings";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { extractExecuteRows } from "../../server/database-result";
import { toVideoGenerationTaskResponse } from "../external-api/async-image-tasks";
import { fetchPublicCallback } from "../external-api/safe-image-fetch";
import { getVideoCallbackRetryAt } from "./video-callback-policy";
import { buildVideoCallbackInput } from "./video-input-lifecycle";

export { createVideoCallbackDeliveryValues } from "./video-callback-policy";

const CALLBACK_TIMEOUT_MS = 10_000;
const CALLBACK_CLAIM_TTL_MS = 2 * 60_000;
const CALLBACK_BATCH_LIMIT = 25;
const CALLBACK_WORKER_COUNT = 4;
const claimedDeliveryRowSchema = z.object({ id: z.string().min(1) });

type VideoCallbackDeliveryRow =
  typeof videoGenerationCallbackDelivery.$inferSelect;

/** 构造回调负载需要的视频终态字段。 */
type VideoCallbackTaskRow = {
  id: string;
  model: string;
  status: string;
  durationSeconds: number;
  creditsConsumed: number;
  error: string | null;
  storageKey: string | null;
  inputManifest: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** 已由当前 token 认领的一条回调及其视频终态。 */
type ClaimedVideoCallback = {
  delivery: VideoCallbackDeliveryRow;
  video: VideoCallbackTaskRow;
};

/**
 * 校验幂等重放没有更换或追加 callback URL。
 *
 * callback 不属于领域输入，必须单独比较持久投递记录，避免同一幂等键被改投到新地址。
 */
export async function doesVideoCallbackDeliveryMatch(
  videoGenerationId: string,
  callbackUrl: string | undefined
): Promise<boolean> {
  const [delivery] = await db
    .select({ callbackUrl: videoGenerationCallbackDelivery.callbackUrl })
    .from(videoGenerationCallbackDelivery)
    .where(
      eq(videoGenerationCallbackDelivery.videoGenerationId, videoGenerationId)
    )
    .limit(1);
  return delivery ? delivery.callbackUrl === callbackUrl : !callbackUrl;
}

/** 原子认领一条已进入终态且到期的回调记录。 */
async function claimNextVideoCallback(
  claimToken: string,
  now: Date
): Promise<string | null> {
  return db.transaction(async (transaction) => {
    const result = await transaction.execute(sql`
      with candidate as (
        select delivery.id
        from video_generation_callback_delivery as delivery
        inner join video_generation as task
          on task.id = delivery.video_generation_id
        where task.status in ('completed', 'failed')
          and delivery.status in ('pending', 'delivering')
          and delivery.next_attempt_at <= ${now}
          and (
            delivery.claim_expires_at is null
            or delivery.claim_expires_at <= ${now}
          )
        order by delivery.next_attempt_at, delivery.created_at, delivery.id
        limit 1
        for update of delivery skip locked
      )
      update video_generation_callback_delivery as delivery
      set status = 'delivering',
          attempt_count = delivery.attempt_count + 1,
          claim_token = ${claimToken},
          claim_expires_at = ${new Date(now.getTime() + CALLBACK_CLAIM_TTL_MS)},
          updated_at = ${now}
      from candidate
      where delivery.id = candidate.id
      returning delivery.id
    `);
    const row = extractExecuteRows(result)[0];
    if (!row) return null;
    return claimedDeliveryRowSchema.parse(row).id;
  });
}

/** 读取本 worker 已认领的投递与终态视频字段。 */
async function loadClaimedVideoCallback(
  deliveryId: string,
  claimToken: string
): Promise<ClaimedVideoCallback | null> {
  const [row] = await db
    .select({
      delivery: videoGenerationCallbackDelivery,
      video: {
        id: videoGeneration.id,
        model: videoGeneration.model,
        status: videoGeneration.status,
        durationSeconds: videoGeneration.durationSeconds,
        creditsConsumed: videoGeneration.creditsConsumed,
        error: videoGeneration.error,
        storageKey: videoGeneration.storageKey,
        inputManifest: videoGeneration.inputManifest,
        createdAt: videoGeneration.createdAt,
        updatedAt: videoGeneration.updatedAt,
      },
    })
    .from(videoGenerationCallbackDelivery)
    .innerJoin(
      videoGeneration,
      eq(videoGeneration.id, videoGenerationCallbackDelivery.videoGenerationId)
    )
    .where(
      and(
        eq(videoGenerationCallbackDelivery.id, deliveryId),
        eq(videoGenerationCallbackDelivery.claimToken, claimToken),
        eq(videoGenerationCallbackDelivery.status, "delivering")
      )
    )
    .limit(1);
  return row ?? null;
}

/** 把本站签名视频 URL 转成外部接收方可访问的绝对 URL。 */
async function buildVideoCallbackUrl(storageKey: string): Promise<string> {
  const publicBaseUrl =
    (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
    (await getRuntimeSettingString("BETTER_AUTH_URL"));
  if (!publicBaseUrl) {
    throw new Error("视频回调缺少 NEXT_PUBLIC_APP_URL/BETTER_AUTH_URL");
  }
  const bucket =
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations";
  const videoUrl = buildPublicImageUrl(
    `/api/storage/${bucket}/${storageKey}`,
    publicBaseUrl,
    24 * 60 * 60
  );
  if (!videoUrl) throw new Error("无法构造视频回调产物 URL");
  return videoUrl;
}

/** 向已在提交期校验过的地址投递一次，并在发送时再次执行 DNS/重定向复检。 */
async function deliverClaimedVideoCallback(input: {
  delivery: VideoCallbackDeliveryRow;
  video: VideoCallbackTaskRow;
}): Promise<void> {
  const videoUrl =
    input.video.status === "completed" && input.video.storageKey
      ? await buildVideoCallbackUrl(input.video.storageKey)
      : null;
  const parsedManifest = videoInputManifestSchema.safeParse(
    input.video.inputManifest ?? {}
  );
  if (!parsedManifest.success) {
    throw new Error("视频 callback 输入清单无效");
  }
  const payload = {
    ...toVideoGenerationTaskResponse(input.video, videoUrl),
    input: buildVideoCallbackInput(parsedManifest.data),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const request = {
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `video-callback:${input.delivery.id}`,
        "X-Tokens-Callback": "true",
        "X-Callback-Delivery-Id": input.delivery.id,
      },
      body: JSON.stringify(payload),
    };
    const response = await fetchPublicCallback(
      input.delivery.callbackUrl,
      request
    );
    if (!response.ok) {
      throw new Error(`视频回调返回 HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** 以 claim token 比较交换把成功投递标记为 delivered。 */
async function completeVideoCallbackDelivery(
  deliveryId: string,
  claimToken: string,
  now: Date
): Promise<void> {
  await db
    .update(videoGenerationCallbackDelivery)
    .set({
      status: "delivered",
      deliveredAt: now,
      claimToken: null,
      claimExpiresAt: null,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(videoGenerationCallbackDelivery.id, deliveryId),
        eq(videoGenerationCallbackDelivery.claimToken, claimToken),
        eq(videoGenerationCallbackDelivery.status, "delivering")
      )
    );
}

/** 以有限指数退避释放失败 claim；最后一次失败进入 dead 等待人工处理。 */
async function retryVideoCallbackDelivery(
  delivery: VideoCallbackDeliveryRow,
  claimToken: string,
  error: unknown,
  now: Date
): Promise<void> {
  const nextAttemptAt = getVideoCallbackRetryAt(delivery.attemptCount, now);
  await db
    .update(videoGenerationCallbackDelivery)
    .set({
      status: nextAttemptAt ? "pending" : "dead",
      nextAttemptAt: nextAttemptAt ?? now,
      claimToken: null,
      claimExpiresAt: null,
      lastError: (error instanceof Error
        ? error.message
        : "视频回调投递失败"
      ).slice(0, 1_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(videoGenerationCallbackDelivery.id, delivery.id),
        eq(videoGenerationCallbackDelivery.claimToken, claimToken),
        eq(videoGenerationCallbackDelivery.status, "delivering")
      )
    );
}

/**
 * 执行一批终态视频回调。
 *
 * 每个 worker 在发送前即时认领一条记录；接收方可用稳定 Idempotency-Key 去重
 * “远端已接受、进程未落 delivered”造成的必要重放。
 */
export async function runVideoCallbackDeliveryJob(): Promise<{
  claimed: number;
  delivered: number;
  failed: number;
}> {
  let reservations = 0;
  let claimed = 0;
  let delivered = 0;
  let failed = 0;

  /** 同步预留批次槽位，避免并行 worker 超过全局批次上限。 */
  const reserveBatchSlot = (): boolean => {
    if (reservations >= CALLBACK_BATCH_LIMIT) return false;
    reservations += 1;
    return true;
  };

  /** 单 worker 即时认领、投递并持久化结果。 */
  const runWorker = async (): Promise<void> => {
    while (reserveBatchSlot()) {
      const claimToken = randomUUID();
      const deliveryId = await claimNextVideoCallback(claimToken, new Date());
      if (!deliveryId) return;
      claimed += 1;
      const row = await loadClaimedVideoCallback(deliveryId, claimToken);
      if (!row) continue;
      try {
        await deliverClaimedVideoCallback(row);
        await completeVideoCallbackDelivery(deliveryId, claimToken, new Date());
        delivered += 1;
      } catch (error) {
        failed += 1;
        logError(error, {
          source: "video-callback-delivery",
          deliveryId,
          videoGenerationId: row.delivery.videoGenerationId,
        });
        await retryVideoCallbackDelivery(
          row.delivery,
          claimToken,
          error,
          new Date()
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: CALLBACK_WORKER_COUNT }, () => runWorker())
  );
  return { claimed, delivered, failed };
}
