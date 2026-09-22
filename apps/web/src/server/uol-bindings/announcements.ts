/** Announcement UOL bindings backed exclusively by the Go gateway. */
import {
  type AdminAnnouncementItem,
  type UserAnnouncementListRecord,
  adminAnnouncementListInputSchema,
  adminAnnouncementListOutputSchema,
  userAnnouncementListInputSchema,
  userAnnouncementListOutputSchema,
} from "@repo/shared/announcements/list-contract";
import { bindExecute, OperationError } from "@repo/shared/uol";
import { requestGoJson } from "@/server/go-backend-client";

type AnnouncementPageResponse<T> = {
  records?: T[];
  items?: T[];
  page?: number;
  pageSize?: number;
  totalCount?: number;
  total?: number;
  totalPages?: number;
  stats?: { active: number; drafts: number; pinned: number };
};

function requireUser(principal: { type: string }) {
  if (principal.type !== "user") {
    throw new OperationError("unauthenticated", "User session authentication required");
  }
}

function requireAdmin(principal: { type: string; role?: string }) {
  if (
    principal.type !== "user" ||
    !["admin", "super_admin"].includes(principal.role ?? "")
  ) {
    throw new OperationError("forbidden", "Admin access required");
  }
}

bindExecute("support.getDashboardConfiguration", async (_input, principal) => {
  requireUser(principal);
  return requestGoJson("/api/support/dashboard-configuration");
});

bindExecute("support.listAnnouncements", async (input, principal) => {
  requireUser(principal);
  const value = input as { page?: number; pageSize?: number };
  const page = Math.max(1, Math.trunc(value.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.trunc(value.pageSize ?? 50)));
  const raw = await requestGoJson<
    AnnouncementPageResponse<UserAnnouncementListRecord>
  >(`/api/announcements?page=${page}&pageSize=${pageSize}`);
  const records = raw.records ?? raw.items ?? [];
  return {
    announcements: records.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      publishedAt: item.publishedAt ?? item.createdAt,
      isRead: Boolean(item.isRead),
    })),
    total: raw.totalCount ?? raw.total ?? records.length,
  };
});

bindExecute("support.listMyAnnouncementPage", async (input, principal) => {
  requireUser(principal);
  const parsed = userAnnouncementListInputSchema.parse(input);
  const raw = await requestGoJson<
    AnnouncementPageResponse<UserAnnouncementListRecord>
  >(`/api/announcements?page=${parsed.page}&pageSize=${parsed.pageSize}`);
  return userAnnouncementListOutputSchema.parse({
    records: raw.records ?? raw.items ?? [],
    page: raw.page ?? parsed.page,
    pageSize: raw.pageSize ?? parsed.pageSize,
    totalCount: raw.totalCount ?? raw.total ?? 0,
    totalPages: raw.totalPages ?? 1,
  });
});

bindExecute("support.countUnreadAnnouncements", async (_input, principal) => {
  requireUser(principal);
  return requestGoJson("/api/announcements/unread-count");
});

bindExecute("support.markAnnouncementRead", async (input, principal) => {
  requireUser(principal);
  const announcementId = String((input as { announcementId: string }).announcementId);
  await requestGoJson(`/api/announcements/read`, {
    method: "POST",
    body: JSON.stringify({ id: announcementId }),
  });
  return { success: true };
});

bindExecute("support.markAllAnnouncementsRead", async (_input, principal) => {
  requireUser(principal);
  const raw = await requestGoJson<{ count?: number }>("/api/announcements/read-all", {
    method: "POST",
    body: "{}",
  });
  return { success: true, markedCount: raw.count ?? 0 };
});

bindExecute("support.getAdminAnnouncements", async (input, principal) => {
  requireAdmin(principal);
  const value = input as { page?: number; pageSize?: number; published?: boolean };
  const page = Math.max(1, Math.trunc(value.page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Math.trunc(value.pageSize ?? 50)));
  const published = value.published === undefined ? "all" : value.published ? "published" : "unpublished";
  const raw = await requestGoJson<
    AnnouncementPageResponse<AdminAnnouncementItem>
  >(
    `/api/admin/announcements?page=${page}&pageSize=${pageSize}&published=${published}`
  );
  const records = raw.records ?? raw.items ?? [];
  return {
    announcements: records.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      isPublished: Boolean(item.isPublished),
      publishedAt: item.publishedAt ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    total: raw.totalCount ?? raw.total ?? records.length,
  };
});

bindExecute("support.listAdminAnnouncementPage", async (input, principal) => {
  requireAdmin(principal);
  const parsed = adminAnnouncementListInputSchema.parse(input);
  const raw = await requestGoJson<
    AnnouncementPageResponse<AdminAnnouncementItem>
  >(
    `/api/admin/announcements?page=${parsed.page}&pageSize=${parsed.pageSize}&published=${parsed.published}`
  );
  return adminAnnouncementListOutputSchema.parse({
    records: raw.records ?? raw.items ?? [],
    page: raw.page ?? parsed.page,
    pageSize: raw.pageSize ?? parsed.pageSize,
    totalCount: raw.totalCount ?? raw.total ?? 0,
    totalPages: raw.totalPages ?? 1,
    stats: raw.stats ?? { active: 0, drafts: 0, pinned: 0 },
  });
});

bindExecute("support.createAnnouncement", async (input, principal) => {
  requireAdmin(principal);
  const raw = await requestGoJson<{ id: string; createdAt: string }>("/api/admin/announcements", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return { id: raw.id, createdAt: raw.createdAt };
});

bindExecute("support.updateAnnouncement", async (input, principal) => {
  requireAdmin(principal);
  const value = input as { announcementId: string; [key: string]: unknown };
  const { announcementId, ...payload } = value;
  const raw = await requestGoJson<{ id?: string; updatedAt: string }>(`/api/admin/announcements/${encodeURIComponent(announcementId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  return { id: raw.id ?? announcementId, updatedAt: raw.updatedAt };
});

bindExecute("support.deleteAnnouncement", async (input, principal) => {
  requireAdmin(principal);
  const announcementId = String((input as { announcementId: string }).announcementId);
  await requestGoJson(`/api/admin/announcements/${encodeURIComponent(announcementId)}`, { method: "DELETE" });
  return { success: true };
});

bindExecute("support.toggleAnnouncementPublish", async (input, principal) => {
  requireAdmin(principal);
  const announcementId = String((input as { announcementId: string }).announcementId);
  const raw = await requestGoJson<{ id?: string; isPublished: boolean; updatedAt?: string }>(`/api/admin/announcements/${encodeURIComponent(announcementId)}/toggle`, {
    method: "POST",
    body: "{}",
  });
  return { id: raw.id ?? announcementId, isPublished: raw.isPublished, updatedAt: raw.updatedAt ?? new Date().toISOString() };
});
