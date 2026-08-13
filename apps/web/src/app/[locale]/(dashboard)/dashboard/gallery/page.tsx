/**
 * 本人图库 Server Component。
 *
 * 职责：校验页签、构造当前用户 Principal，并通过 UOL 读取首批卡片。后续触底追加
 * 由客户端调用同一 operation；页面不再计算总数或按 `page * 20` 重查累计数据。
 */

import { getUserRoleById } from "@repo/shared/auth/role-server";
import { getCurrentUser } from "@repo/shared/auth/server";
import type {
  GalleryListOutput,
  GalleryTab,
} from "@repo/shared/image-generation/gallery-contract";
import { getUserTimeZone } from "@repo/shared/time-zone/server";
import { invokeOperation } from "@repo/shared/uol";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { GalleryClient } from "@/features/image-generation/components/gallery-client";
import { ensureUolInitialized } from "@/server/uol-init";

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
  const [user, locale, params] = await Promise.all([
    getCurrentUser(),
    getLocale(),
    searchParams,
  ]);
  if (!user) redirect(`/${locale}/sign-in`);
  const copy = (en: string, zh: string) => (locale === "zh" ? zh : en);
  const activeTab = parseGalleryTab(params.tab);
  await ensureUolInitialized();
  const [role, timeZone] = await Promise.all([
    getUserRoleById(user.id),
    getUserTimeZone(user.id),
  ]);
  const initialBatch = await invokeOperation<GalleryListOutput>(
    "image.listMyGallery",
    { cursor: null, limit: 20, tab: activeTab },
    { type: "user", userId: user.id, role }
  );

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
        principalFingerprint={user.id}
        timeZone={timeZone}
      />
    </div>
  );
}
