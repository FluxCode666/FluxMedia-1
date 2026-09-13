/**
 * 本人图库 Server Component。
 *
 * 职责：校验页签、构造当前用户 Principal，并通过 UOL 读取首批卡片。后续触底追加
 * 由客户端调用同一 operation；页面不再计算总数或按 `page * 20` 重查累计数据。
 */

import { getServerSession } from "@repo/shared/auth/server";
import type {
  GalleryListOutput,
  GalleryTab,
} from "@repo/shared/image-generation/gallery-contract";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { GalleryClient } from "@/features/image-generation/components/gallery-client";
import { requestGoJson } from "@/server/go-backend-client";

interface GalleryPageProps {
  searchParams: Promise<{ tab?: string }>;
}

/** 将不可信 URL 页签收敛到三个已支持值。 */
function parseGalleryTab(value: string | undefined): GalleryTab {
  if (value === "uploads" || value === "videos") return value;
  return "final";
}

/** 渲染图库首批；数据库错误继续抛给 Next 错误边界，不伪装为空图库。 */
export default async function GalleryPage({ searchParams }: GalleryPageProps) {
  const [session, locale, params] = await Promise.all([
    getServerSession(),
    getLocale(),
    searchParams,
  ]);
  if (!session?.user) redirect(`/${locale}/sign-in`);
  const copy = (en: string, zh: string) => (locale === "zh" ? zh : en);
  const activeTab = parseGalleryTab(params.tab);
  const [initialBatch, profile, mediaLimits] = await Promise.all([
    requestGoJson<GalleryListOutput>("/api/image-generation/gallery", {
      method: "POST",
      body: JSON.stringify({ cursor: null, limit: 20, tab: activeTab }),
    }),
    requestGoJson<{ timeZone?: string; defaultTimeZone?: string }>(
      "/api/user/profile"
    ),
    requestGoJson<{ maxEditReferenceImages: number }>(
      "/api/image-generation/media-limits"
    ),
  ]);

  return (
    <div className="container mx-auto space-y-8 px-4 py-6 md:px-6">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">
          {copy("Gallery", "图库")}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {copy("Your generated media", "你生成的媒体")}
        </p>
      </div>
      <GalleryClient
        key={activeTab}
        initialBatch={initialBatch}
        activeTab={activeTab}
        principalFingerprint={session.user.id}
        timeZone={profile.timeZone || profile.defaultTimeZone || "UTC"}
        maxReferenceImages={mediaLimits.maxEditReferenceImages}
      />
    </div>
  );
}
