/**
 * 视频任务输入资产授权与账号删除生命周期服务。
 *
 * 职责：只从任务具名清单签发短期读取 URL，并把账号删除转换为按对象持久化的
 * lifecycle_delete 意图；不接受客户端提供 bucket、key 或供应商素材身份。
 * 使用方：video.getInputs、video.requestAccountInputCleanup UOL binding。
 */
import { createHash } from "node:crypto";
import { videoGeneration } from "@repo/database/schema";
import {
  listVideoInputManifestReferences,
  type VideoInputManifest,
  videoInputManifestSchema,
} from "@repo/shared/image-generation/media-contract";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import {
  type OperationContext,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import { eq } from "drizzle-orm";

import { enqueueVideoInputCleanup } from "./video-input-cleanup-queue";
import {
  buildVideoInputSummary,
  createLifecycleCleanupObjects,
} from "./video-input-lifecycle";

const VIDEO_INPUT_URL_TTL_SECONDS = 15 * 60;
const VIDEO_INPUT_ADMIN_ROLES = [
  "observer_admin",
  "admin",
  "super_admin",
] as const;

/** 输入资产服务消费的最小任务快照。 */
export type VideoInputAssetTask = {
  id: string;
  userId: string;
  inputManifest: unknown;
};

/** DB-free 测试可替换的数据和签名依赖。 */
export interface VideoInputAssetDependencies {
  findTask(taskId: string): Promise<VideoInputAssetTask | null>;
  listUserTasks(userId: string): Promise<VideoInputAssetTask[]>;
  getCurrentBucket(): Promise<string>;
  signAsset(input: {
    storageKey: string;
    storageBucket: string;
  }): Promise<string>;
  enqueueLifecycleCleanup(
    objects: ReturnType<typeof createLifecycleCleanupObjects>
  ): Promise<number>;
}

/** 生产依赖只查询任务白名单列，不加载 prompt、凭据或供应商身份。 */
const defaultDependencies: VideoInputAssetDependencies = {
  async findTask(taskId) {
    const { db } = await import("@repo/database");
    const [row] = await db
      .select({
        id: videoGeneration.id,
        userId: videoGeneration.userId,
        inputManifest: videoGeneration.inputManifest,
      })
      .from(videoGeneration)
      .where(eq(videoGeneration.id, taskId))
      .limit(1);
    return row ?? null;
  },
  async listUserTasks(userId) {
    const { db } = await import("@repo/database");
    return db
      .select({
        id: videoGeneration.id,
        userId: videoGeneration.userId,
        inputManifest: videoGeneration.inputManifest,
      })
      .from(videoGeneration)
      .where(eq(videoGeneration.userId, userId));
  },
  async getCurrentBucket() {
    const { getStorageRuntimeSnapshot } = await import(
      "@repo/shared/storage/providers"
    );
    return (await getStorageRuntimeSnapshot()).bucketName;
  },
  async signAsset(input) {
    const { getRuntimeSettingString } = await import(
      "@repo/shared/system-settings"
    );
    const relativeUrl = buildSignedStorageImageUrl(
      input.storageKey,
      input.storageBucket,
      VIDEO_INPUT_URL_TTL_SECONDS
    );
    if (!relativeUrl) throw new Error("视频输入短期 URL 签发失败");
    const publicBaseUrl =
      (await getRuntimeSettingString("NEXT_PUBLIC_APP_URL")) ||
      (await getRuntimeSettingString("BETTER_AUTH_URL"));
    if (!publicBaseUrl) throw new Error("站点公开 URL 尚未配置");
    return new URL(relativeUrl, publicBaseUrl).toString();
  },
  async enqueueLifecycleCleanup(objects) {
    return enqueueVideoInputCleanup(objects);
  },
};

/** 只允许任务所有者或现有全局历史管理角色读取实际输入。 */
function assertCanReadVideoInputTask(
  task: VideoInputAssetTask,
  principal: Principal,
  context: OperationContext
): void {
  if (principal.type !== "user") {
    throw new OperationError("not_found", "Video task inputs not found");
  }
  if (principal.userId === task.userId) {
    context.assertOwnership("video task inputs", task.userId);
    return;
  }
  if (
    VIDEO_INPUT_ADMIN_ROLES.includes(
      principal.role as (typeof VIDEO_INPUT_ADMIN_ROLES)[number]
    )
  ) {
    return;
  }
  throw new OperationError("not_found", "Video task inputs not found");
}

/** 校验清单中的每个对象都属于当前 bucket、用户与任务前缀。 */
function assertTrustedManifest(input: {
  task: VideoInputAssetTask;
  manifest: VideoInputManifest;
  currentBucket: string;
}): void {
  const prefix = `${input.task.userId}/video-inputs/${input.task.id}/`;
  if (
    listVideoInputManifestReferences(input.manifest).some(
      (reference) =>
        reference.storageBucket !== input.currentBucket ||
        !reference.storageKey.startsWith(prefix)
    )
  ) {
    throw new OperationError(
      "internal_error",
      "视频任务输入清单包含不受信任对象"
    );
  }
}

/**
 * 为授权主体返回任务白名单输入的短期 URL。
 *
 * @param input 任务 ID、可信 Principal 与统一操作上下文。
 * @returns 具名站内详情 DTO；不包含 bucket、key 或供应商素材 ID。
 * @sideEffects 读取任务和运行时存储配置并签发短期 URL。
 * @throws 未授权时 not_found，清单损坏时 internal_error。
 */
export async function getVideoInputAssets(
  input: {
    taskId: string;
    principal: Principal;
    context: OperationContext;
  },
  dependencies: VideoInputAssetDependencies = defaultDependencies
): Promise<{
  taskId: string;
  summary: ReturnType<typeof buildVideoInputSummary>;
  firstFrame?: { url: string; mimeType: string };
  lastFrame?: { url: string; mimeType: string };
  referenceImages?: Array<{ url: string; mimeType: string }>;
  referenceVideos?: Array<{ url: string; mimeType: string }>;
  referenceAudios?: Array<{ url: string; mimeType: string }>;
}> {
  const task = await dependencies.findTask(input.taskId);
  if (!task) {
    throw new OperationError("not_found", "Video task inputs not found");
  }
  assertCanReadVideoInputTask(task, input.principal, input.context);
  const parsed = videoInputManifestSchema.safeParse(task.inputManifest ?? {});
  if (!parsed.success) {
    throw new OperationError("internal_error", "视频任务输入清单暂时不可用");
  }
  const manifest = parsed.data;
  if (listVideoInputManifestReferences(manifest).length) {
    assertTrustedManifest({
      task,
      manifest,
      currentBucket: await dependencies.getCurrentBucket(),
    });
  }
  const sign = async (
    reference: NonNullable<VideoInputManifest["firstFrame"]>
  ): Promise<{ url: string; mimeType: string }> => ({
    url: await dependencies.signAsset(reference),
    mimeType: reference.mimeType,
  });
  return {
    taskId: task.id,
    summary: buildVideoInputSummary(manifest),
    ...(manifest.firstFrame
      ? { firstFrame: await sign(manifest.firstFrame) }
      : {}),
    ...(manifest.lastFrame
      ? { lastFrame: await sign(manifest.lastFrame) }
      : {}),
    ...(manifest.referenceImages?.length
      ? {
          referenceImages: await Promise.all(
            manifest.referenceImages.map(sign)
          ),
        }
      : {}),
    ...(manifest.referenceVideos?.length
      ? {
          referenceVideos: await Promise.all(
            manifest.referenceVideos.map(sign)
          ),
        }
      : {}),
    ...(manifest.referenceAudios?.length
      ? {
          referenceAudios: await Promise.all(
            manifest.referenceAudios.map(sign)
          ),
        }
      : {}),
  };
}

/**
 * 幂等登记当前账号全部视频输入的生命周期删除意图。
 *
 * @param input 当前用户与 per-user 幂等请求键。
 * @returns 稳定请求 ID 和排队状态。
 * @sideEffects 读取当前任务清单并 upsert lifecycle_delete 队列行。
 * @throws 任一持久清单不可信时整体失败，账号仍保持有效且 worker 不会删除对象。
 */
export async function requestVideoAccountInputCleanup(
  input: { userId: string; clientRequestId: string },
  dependencies: VideoInputAssetDependencies = defaultDependencies
): Promise<{ cleanupRequestId: string; status: "queued" | "existing" }> {
  const cleanupRequestId = createHash("sha256")
    .update(input.userId)
    .update("\0")
    .update(input.clientRequestId)
    .digest("hex");
  const tasks = await dependencies.listUserTasks(input.userId);
  let currentBucket: string | undefined;
  for (const task of tasks) {
    const parsed = videoInputManifestSchema.safeParse(task.inputManifest ?? {});
    if (!parsed.success) {
      throw new Error(`视频任务 ${task.id} 的输入清单无效`);
    }
    if (!listVideoInputManifestReferences(parsed.data).length) continue;
    currentBucket ??= await dependencies.getCurrentBucket();
    assertTrustedManifest({ task, manifest: parsed.data, currentBucket });
    const objects = createLifecycleCleanupObjects({
      userId: task.userId,
      videoId: task.id,
      manifest: parsed.data,
    });
    if (objects.length) await dependencies.enqueueLifecycleCleanup(objects);
  }
  return { cleanupRequestId, status: "queued" };
}
