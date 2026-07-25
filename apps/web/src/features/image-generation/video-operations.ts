/**
 * 统一媒体号池的 Adobe Firefly 视频生成编排（财务闭环）。
 *
 * 职责：校验视频模型 → 从系统设置算价（模型族每秒价格 × 时长）→ 落 video_generation
 * (pending) → 按分组、显式模型能力和动态策略原子获租 → 幂等扣费
 * （consumeCredits，sourceRef）→ 派发 Adobe direct 视频请求 → 产物 re-host 到对象
 * 存储 → 标记 completed；仅上游明确未接受的失败可跨成员切换，已取得
 * 上游任务的错误不得重投。
 *
 * 不变量：财务真相在 credits_transaction；扣费/退款都带 sourceRef 幂等键和同一 video
 * operation context，杜绝重复扣/重复退及跨日归属漂移。
 * 关键依赖：createRuntimeBackendSession（统一调度）、
 * runAdobeDirectVideoRequest（派发）、storage 与 credits。
 */

import { db } from "@repo/database";
import { videoGeneration } from "@repo/database/schema";
import {
  ADOBE_VIDEO_PRICING_FAMILIES,
  DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND,
  getVideoCreditCost,
  globalVideoModelCreditsPerSecondSchema,
  resolveEffectiveVideoCreditsPerSecond,
} from "@repo/shared/adobe";
import { resolveFireflyVideoModel } from "@repo/shared/adobe/firefly-direct";
import { consumeCredits } from "@repo/shared/credits/core";
import { refundGenerationCredits } from "@repo/shared/generation-maintenance";
import { logError } from "@repo/shared/logger";
import { getStorageProvider } from "@repo/shared/storage/providers";
import {
  getRuntimeSettingJson,
  getRuntimeSettingString,
} from "@repo/shared/system-settings";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { completeVideoGenerationWithUsage } from "@/features/dashboard/output-usage-read-model";
import { createRuntimeBackendSession } from "@/features/image-backend-pool/runtime-service";
import { runAdobeDirectVideoRequest } from "./adobe-direct";
import { createVideoCreditOperation } from "./credit-operation-context";

export type VideoGenerationInput = {
  userId: string;
  apiKeyId?: string | null;
  prompt: string;
  /**
   * 预供的 video_generation 行 id（可选）。异步路径预先生成并传入,使任务的
   * generation_id 与落库行 id 一致,便于后续按 id 持久查询;不传则内部生成。
   */
  videoGenerationId?: string;
  /** UOL Principal 作用域内的原始幂等键，只写任务 metadata。 */
  clientRequestId?: string;
  /** 用于拒绝同幂等键却载荷不同的重放。 */
  requestFingerprint?: string;
  /** Firefly 或裸 Veo/Kling 视频 model id（<family>-<dur>s-<ratio>[-<res>]）。 */
  model: string;
  /** 经过传输层校验的可选统一后端分组。 */
  backendGroupId?: string;
  negativePrompt?: string | null;
  /** 图生视频输入图（首帧/尾帧/参考）。 */
  inputImages?: Array<{ data: Buffer; type?: string | null }>;
  /** 输入图来源引用（@ 历史图：generationId / storageKey），仅作记录。 */
  inputImageRefs?: Array<{
    generationId?: string;
    storageKey?: string;
    role?: string;
  }>;
  signal?: AbortSignal;
};

export type VideoGenerationResult =
  | {
      videoGenerationId: string;
      storageKey: string;
      creditsConsumed: number;
    }
  | { error: string; videoGenerationId?: string };

/** 创作页视频价格预估所需的定价输入（前端据此按 family×时长 实时算价）。 */
export type VideoPricingInfo = {
  /** 已按“分组 > 全局”解析完成的模型族每秒积分 map。 */
  creditsPerSecond: Record<string, number>;
};

/** 读取必填全局视频模型价格；历史脏值只回退开发默认值。 */
async function getRuntimeGlobalVideoPricing(): Promise<Record<string, number>> {
  const parsed = globalVideoModelCreditsPerSecondSchema.safeParse(
    await getRuntimeSettingJson("VIDEO_MODEL_CREDITS_PER_SECOND")
  );
  return parsed.success
    ? parsed.data
    : { ...DEFAULT_VIDEO_MODEL_CREDITS_PER_SECOND };
}

/**
 * 取视频定价输入（模型族每秒积分 + 全局回退基价），供创作页前端实时预估。
 * 与扣费侧 runAdobeVideoGenerationForUser 共用系统设置和纯计算口径，保证展示价与实扣价一致。
 */
export async function getVideoPricingForUser(input: {
  userId: string;
  apiKeyId?: string | null;
  group?: Record<string, number> | null;
}): Promise<VideoPricingInfo> {
  void input.userId;
  void input.apiKeyId;
  const global = await getRuntimeGlobalVideoPricing();
  return {
    creditsPerSecond: Object.fromEntries(
      ADOBE_VIDEO_PRICING_FAMILIES.map((family) => [
        family,
        resolveEffectiveVideoCreditsPerSecond({
          family,
          global,
          group: input.group,
        }),
      ])
    ),
  };
}

/**
 * 按 id 查一条 video_generation（DB 持久,供 /v1/videos/{id} 任务查询）。
 * 不带归属过滤,调用方须自行校验 userId 防越权。
 */
export async function getVideoGenerationById(id: string) {
  const rows = await db
    .select()
    .from(videoGeneration)
    .where(eq(videoGeneration.id, id))
    .limit(1);
  return rows[0] || null;
}

async function markVideoFailed(id: string, error: string): Promise<void> {
  await db
    .update(videoGeneration)
    .set({
      status: "failed",
      error: error.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(eq(videoGeneration.id, id))
    .catch(() => {});
}

/**
 * 跑一次统一号池调度的 Adobe Firefly 视频生成（含计费与持久化）。
 */
export async function runAdobeVideoGenerationForUser(
  input: VideoGenerationInput
): Promise<VideoGenerationResult> {
  const conf = resolveFireflyVideoModel(input.model);
  if (!conf) {
    return { error: `不支持的视频模型: ${input.model}` };
  }

  const globalVideoPricing = await getRuntimeGlobalVideoPricing();

  const videoId = input.videoGenerationId || nanoid();
  // 扣费/退款幂等键：派生自服务端 videoId，全局唯一。
  const sourceRef = `adobe-video:${videoId}`;
  const now = new Date();
  const creditOperation = createVideoCreditOperation(videoId, now);

  await db.insert(videoGeneration).values({
    id: videoId,
    userId: input.userId,
    apiKeyId: input.apiKeyId ?? null,
    usageLogVisible: true,
    model: input.model,
    family: conf.family,
    prompt: input.prompt,
    durationSeconds: conf.duration,
    aspectRatio: conf.aspectRatio,
    resolution: conf.outputResolution,
    status: "pending",
    creditsConsumed: 0,
    ...(input.clientRequestId || input.requestFingerprint
      ? {
          metadata: {
            ...(input.clientRequestId
              ? { clientRequestId: input.clientRequestId }
              : {}),
            ...(input.requestFingerprint
              ? { requestFingerprint: input.requestFingerprint }
              : {}),
          },
        }
      : {}),
    ...(input.inputImageRefs?.length
      ? { inputImageRefs: input.inputImageRefs }
      : {}),
    createdAt: now,
    updatedAt: now,
  });

  // 调度只使用显式模型能力和分组策略，不从模型前缀推断成员类型。
  let backendSession: Awaited<ReturnType<typeof createRuntimeBackendSession>>;
  try {
    backendSession = await createRuntimeBackendSession({
      userId: input.userId,
      ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
      ...(input.backendGroupId
        ? { requestedGroupId: input.backendGroupId }
        : {}),
      modelId: input.model,
      requestKind: "video",
      requiresContentSafety: true,
    });
    await backendSession.acquireNext();
  } catch (error) {
    await markVideoFailed(
      videoId,
      error instanceof Error ? error.message : "无可用后端"
    );
    return { error: "无可用 Adobe 视频后端", videoGenerationId: videoId };
  }

  // WHY: 先完成分组调度，才能取得本次计费分组的稀疏覆盖；随后按“分组 > 全局”计算
  // 实扣，避免视频继续绕过分组价格。
  const billedCost = getVideoCreditCost({
    durationSeconds: conf.duration,
    creditsPerSecond: resolveEffectiveVideoCreditsPerSecond({
      family: conf.family,
      global: globalVideoPricing,
      group: backendSession.group.videoCreditOverrides,
    }),
  });

  if (
    backendSession.current?.memberType !== "adobe" ||
    backendSession.current.adobeMode !== "direct"
  ) {
    await backendSession.close();
    await markVideoFailed(videoId, "命中后端非 Adobe 直连");
    return {
      error: "视频生成需要一个 Adobe 直连(direct)后端",
      videoGenerationId: videoId,
    };
  }

  // 预扣积分（幂等 sourceRef）。不足/失败 → 标记 failed 返回。
  try {
    await consumeCredits({
      userId: input.userId,
      amount: billedCost,
      serviceName: "adobe-video",
      description: `Adobe 视频生成 ${input.model}`,
      sourceRef,
      operation: creditOperation,
      metadata: {
        videoGenerationId: videoId,
        model: input.model,
        durationSeconds: conf.duration,
        ...(input.apiKeyId ? { externalApiKeyId: input.apiKeyId } : {}),
      },
    });
  } catch (error) {
    await backendSession.close();
    await markVideoFailed(videoId, "积分不足");
    return {
      error: error instanceof Error ? error.message : "积分不足",
      videoGenerationId: videoId,
    };
  }

  await db
    .update(videoGeneration)
    .set({
      status: "running",
      creditsConsumed: billedCost,
      backendMemberId: backendSession.current.memberId,
      updatedAt: new Date(),
    })
    .where(eq(videoGeneration.id, videoId));

  // 失败统一退款 + 标记。退款幂等（同一 sourceRef 只退一次）。
  const failAndRefund = async (
    message: string
  ): Promise<VideoGenerationResult> => {
    await backendSession.close();
    await refundGenerationCredits({
      generationId: videoId,
      userId: input.userId,
      amount: billedCost,
      sourceRef,
      description: `Adobe 视频生成失败退款 ${input.model}`,
      operation: creditOperation,
    }).catch((error) =>
      logError(error, { source: "adobe-video-refund", videoId })
    );
    await db
      .update(videoGeneration)
      .set({
        status: "failed",
        error: message.slice(0, 1000),
        creditsConsumed: 0,
        updatedAt: new Date(),
      })
      .where(eq(videoGeneration.id, videoId));
    return { error: message, videoGenerationId: videoId };
  };

  // 只有上游明确未接受提交的可切换错误才排除当前成员重选。
  // 一旦 Adobe 已返回轮询任务，adapter 会把后续错误标记为不可切换，
  // 避免跨 token 或跨成员重复提交。
  let result: Exclude<
    Awaited<ReturnType<typeof runAdobeDirectVideoRequest>>,
    { error: string }
  >;
  for (;;) {
    const lease = backendSession.current;
    if (!lease) {
      return failAndRefund("视频后端租约已失效，请重试");
    }
    const startedAt = Date.now();
    const attempt = await runAdobeDirectVideoRequest(lease.config, {
      prompt: input.prompt,
      model: input.model,
      ...(input.inputImages ? { inputImages: input.inputImages } : {}),
      ...(input.negativePrompt != null
        ? { negativePrompt: input.negativePrompt }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }).catch((error) => ({
      error: error instanceof Error ? error.message : "Adobe 视频调用失败",
      switchable: false,
      upstreamAccepted: false,
      terminal: false,
    }));
    const durationMs = Date.now() - startedAt;
    if (!("error" in attempt)) {
      result = attempt;
      await backendSession.completeCurrent({
        success: true,
        durationMs,
      });
      break;
    }
    if (!attempt.switchable) {
      await backendSession.completeCurrent({
        success: false,
        error: attempt.error,
        durationMs,
        terminal: attempt.terminal,
      });
      return failAndRefund(attempt.error);
    }
    try {
      const nextLease = await backendSession.switchAfterFailure(
        attempt.error,
        durationMs
      );
      await db
        .update(videoGeneration)
        .set({
          backendMemberId: nextLease.memberId,
          updatedAt: new Date(),
        })
        .where(eq(videoGeneration.id, videoId));
    } catch (error) {
      return failAndRefund(
        error instanceof Error ? error.message : "无可用 Adobe 视频后端"
      );
    }
  }

  // re-host 视频到对象存储。
  const bucket =
    (await getRuntimeSettingString("NEXT_PUBLIC_GENERATIONS_BUCKET_NAME")) ||
    "generations";
  const storageKey = `${input.userId}/${nanoid(32)}.mp4`;
  try {
    const storage = await getStorageProvider();
    await storage.putObject(
      storageKey,
      bucket,
      result.bytes,
      result.contentType || "video/mp4"
    );
  } catch (error) {
    logError(error, { source: "adobe-video-rehost", videoId });
    return failAndRefund("视频已生成但存储失败，已退款，请重试");
  }

  const completedAt = new Date();
  try {
    await completeVideoGenerationWithUsage({
      videoGenerationId: videoId,
      storageKey,
      completedAt,
    });
  } catch (error) {
    logError(error, { source: "adobe-video-complete", videoId });
    return failAndRefund("视频已生成但完成记录失败，已退款，请重试");
  }
  return {
    videoGenerationId: videoId,
    storageKey,
    creditsConsumed: billedCost,
  };
}
