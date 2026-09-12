"use server";

import { adminAction, protectedAction } from "@repo/shared/safe-action";
import {
  announcementIdSchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
} from "@repo/shared/announcements/schemas";
import { revalidatePath } from "next/cache";
import { requestGoJson } from "@/server/go-backend-client";

const withAnnouncementAction = (name: string) =>
  protectedAction.metadata({ action: `announcements.${name}` });
const withAdminAnnouncementAction = (name: string) =>
  adminAction.metadata({ action: `announcements.admin.${name}` });

export const getMyUnreadAnnouncementCountAction = withAnnouncementAction("getMyUnreadCount").action(
  async () => requestGoJson<{ count: number }>("/api/announcements/unread-count")
);

export const markAllAnnouncementsReadAction = withAnnouncementAction("markAllRead").action(async () => {
  const result = await requestGoJson<{ count?: number }>("/api/announcements/read-all", { method: "POST", body: "{}" });
  revalidatePath("/dashboard/announcements");
  return { count: result.count ?? 0 };
});

export const markAnnouncementReadAction = withAnnouncementAction("markRead")
  .schema(announcementIdSchema)
  .action(async ({ parsedInput }) => {
    const result = await requestGoJson<{ message?: string }>("/api/announcements/read", { method: "POST", body: JSON.stringify(parsedInput) });
    revalidatePath("/dashboard/announcements");
    return { message: result.message ?? "已标记为已读" };
  });

export const createAnnouncementAction = withAdminAnnouncementAction("create")
  .schema(createAnnouncementSchema)
  .action(async ({ parsedInput }) => {
    const result = await requestGoJson<{ id: string; message?: string }>("/api/admin/announcements", { method: "POST", body: JSON.stringify(parsedInput) });
    revalidatePath("/dashboard/announcements");
    revalidatePath("/dashboard/admin/announcements");
    return { message: result.message ?? "公告已创建", id: result.id };
  });

export const updateAnnouncementAction = withAdminAnnouncementAction("update")
  .schema(updateAnnouncementSchema)
  .action(async ({ parsedInput }) => {
    const { id, ...payload } = parsedInput;
    const result = await requestGoJson<{ message?: string }>(`/api/admin/announcements/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) });
    revalidatePath("/dashboard/announcements");
    revalidatePath("/dashboard/admin/announcements");
    return { message: result.message ?? "公告已更新" };
  });

export const deleteAnnouncementAction = withAdminAnnouncementAction("delete")
  .schema(announcementIdSchema)
  .action(async ({ parsedInput }) => {
    const result = await requestGoJson<{ message?: string }>(`/api/admin/announcements/${encodeURIComponent(parsedInput.id)}`, { method: "DELETE" });
    revalidatePath("/dashboard/announcements");
    revalidatePath("/dashboard/admin/announcements");
    return { message: result.message ?? "公告已删除" };
  });

export const toggleAnnouncementPublishAction = withAdminAnnouncementAction("togglePublish")
  .schema(announcementIdSchema)
  .action(async ({ parsedInput }) => {
    const result = await requestGoJson<{ isPublished: boolean }>(`/api/admin/announcements/${encodeURIComponent(parsedInput.id)}/toggle`, { method: "POST", body: "{}" });
    revalidatePath("/dashboard/announcements");
    revalidatePath("/dashboard/admin/announcements");
    return result;
  });
