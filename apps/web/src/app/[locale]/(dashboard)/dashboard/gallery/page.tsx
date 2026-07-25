import { db } from "@repo/database";
import { generation, videoGeneration } from "@repo/database/schema";
import { getCurrentUser } from "@repo/shared/auth/server";
import { buildSignedStorageImageUrl } from "@repo/shared/storage/signed-url";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { GalleryClient } from "@/features/image-generation/components/gallery-client";
import {
  extractGenerationReferenceImages,
  extractPromptRepairNotice,
} from "@/features/image-generation/generation-metadata";

interface GalleryPageProps {
  searchParams: Promise<{ page?: string; tab?: string }>;
}

type GalleryOutputRole = "final" | "upload" | "video";
type GalleryTab = "final" | "uploads" | "videos";

function formatUploadedImageSize(
  image: ReturnType<typeof extractGenerationReferenceImages>[number],
  copy: (en: string, zh: string) => string
) {
  if (image.sizeBytes && image.sizeBytes > 0) {
    const megabytes = image.sizeBytes / 1024 / 1024;
    return `${megabytes >= 0.1 ? megabytes.toFixed(1) : "<0.1"} MB`;
  }
  return copy("Uploaded", "上传图");
}

function extractUploadedImageGenerations(
  rows: Array<typeof generation.$inferSelect>,
  copy: (en: string, zh: string) => string
) {
  return rows.flatMap((g) => {
    const referenceImages = extractGenerationReferenceImages(g.metadata);
    return referenceImages.map((image, index) => ({
      id: `${g.id}-upload-${image.id || index + 1}`,
      parentId: g.id,
      prompt: g.prompt,
      revisedPrompt: g.revisedPrompt,
      promptRepairNotice: extractPromptRepairNotice(g.metadata),
      model: image.type || copy("User upload", "用户上传"),
      size: formatUploadedImageSize(image, copy),
      status: "completed" as const,
      creditsConsumed: 0,
      storageKey: image.storageKey,
      storageBucket: image.storageBucket,
      imageUrl: image.imageUrl,
      createdAt: g.createdAt.toISOString(),
      outputRole: "upload" as GalleryOutputRole,
      referenceImages,
    }));
  });
}

export default async function GalleryPage({ searchParams }: GalleryPageProps) {
  const user = await getCurrentUser();
  const locale = await getLocale();
  if (!user) redirect(`/${locale}/sign-in`);
  const isZh = locale === "zh";
  const copy = (en: string, zh: string) => (isZh ? zh : en);

  const params = await searchParams;
  const PAGE_SIZE = 20;
  const activeTab: GalleryTab =
    params.tab === "uploads"
      ? "uploads"
      : params.tab === "videos"
        ? "videos"
        : "final";
  const pageParam = Number(params.page);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const limit = page * PAGE_SIZE;
  const finalCondition = and(
    eq(generation.userId, user.id),
    eq(generation.status, "completed"),
    isNotNull(generation.storageKey)
  );
  // @? jsonpath 谓词:命中"inputImages.images 至少有一个元素"的行。等价于原
  // jsonb_array_length(... ) > 0（已校验命中数一致），可走 generation_metadata_gin_idx。
  const uploadCondition = and(
    eq(generation.userId, user.id),
    isNotNull(generation.metadata),
    sql`(${generation.metadata}::jsonb) @? '$.inputImages.images[0]'`
  );
  // 仅当前标签加载明细；徽标使用独立 COUNT，避免把其他标签数据读入内存。
  // 视频(video_generation):已完成且有产物的视频,作为图库「视频」tab。
  const videoCondition = and(
    eq(videoGeneration.userId, user.id),
    eq(videoGeneration.status, "completed"),
    isNotNull(videoGeneration.storageKey)
  );
  const isFinalTab = activeTab === "final";
  const isVideosTab = activeTab === "videos";
  const [
    finalRows,
    finalCountResult,
    uploadParentRows,
    uploadCountResult,
    videoRows,
    videoCountResult,
    timeZone,
  ] = await Promise.all([
    isFinalTab
      ? db
          .select()
          .from(generation)
          .where(finalCondition)
          .orderBy(desc(generation.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof generation.$inferSelect>),
    db.select({ count: count() }).from(generation).where(finalCondition),
    activeTab === "uploads"
      ? db
          .select()
          .from(generation)
          .where(uploadCondition)
          .orderBy(desc(generation.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof generation.$inferSelect>),
    db.select({ count: count() }).from(generation).where(uploadCondition),
    isVideosTab
      ? db
          .select()
          .from(videoGeneration)
          .where(videoCondition)
          .orderBy(desc(videoGeneration.createdAt))
          .limit(limit)
      : Promise.resolve([] as Array<typeof videoGeneration.$inferSelect>),
    db.select({ count: count() }).from(videoGeneration).where(videoCondition),
    getUserTimeZone(user.id),
  ]);

  const allUploadItems = extractUploadedImageGenerations(
    uploadParentRows,
    copy
  );
  const videoItems = videoRows.map((v) => ({
    id: v.id,
    parentId: v.id,
    prompt: v.prompt,
    revisedPrompt: null,
    promptRepairNotice: null,
    model: v.model,
    size: `${v.durationSeconds}s · ${v.aspectRatio} · ${v.resolution}`,
    status: v.status as "pending" | "completed" | "failed",
    creditsConsumed: Number(v.creditsConsumed) || 0,
    storageKey: v.storageKey,
    storageBucket: null,
    imageUrl: null,
    // video_generation 无 storageBucket 列,buildSignedStorageImageUrl 默认 generations 桶。
    videoUrl: buildSignedStorageImageUrl(v.storageKey, null),
    createdAt: v.createdAt.toISOString(),
    outputRole: "video" as GalleryOutputRole,
    referenceImages: [],
  }));
  const displayedItems =
    activeTab === "videos"
      ? videoItems
      : activeTab === "uploads"
        ? allUploadItems.slice(0, limit)
        : finalRows.map((g) => ({
            id: g.id,
            parentId: g.id,
            prompt: g.prompt,
            revisedPrompt: g.revisedPrompt,
            promptRepairNotice: extractPromptRepairNotice(g.metadata),
            model: g.model,
            size: g.size,
            status: g.status,
            creditsConsumed: g.creditsConsumed,
            storageKey: g.storageKey,
            storageBucket: g.storageBucket,
            imageUrl: buildSignedStorageImageUrl(g.storageKey, g.storageBucket),
            createdAt: g.createdAt.toISOString(),
            outputRole: "final" as GalleryOutputRole,
            referenceImages: extractGenerationReferenceImages(g.metadata),
          }));

  const finalCount = finalCountResult[0]?.count ?? 0;
  const uploadCount = uploadCountResult[0]?.count ?? 0;
  const videoCount = videoCountResult[0]?.count ?? 0;
  const totalCount =
    activeTab === "videos"
      ? videoCount
      : activeTab === "uploads"
        ? uploadCount
        : finalCount;

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy("Gallery", "图库")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy("Your generated images", "你生成的图片")}
        </p>
      </div>
      <GalleryClient
        key={`${activeTab}-${page}`}
        initialGenerations={displayedItems}
        totalCount={totalCount}
        finalCount={finalCount}
        uploadCount={uploadCount}
        videoCount={videoCount}
        activeTab={activeTab}
        page={page}
        timeZone={timeZone}
      />
    </div>
  );
}
