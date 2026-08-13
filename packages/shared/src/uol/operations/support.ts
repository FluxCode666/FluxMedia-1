/**
 * UOL Operations - Support & Announcements Domain
 *
 * 职责：注册控制台支持配置、客服工单与公告相关的全部操作定义。
 * 使用方：UOL registry 全局注册表，经 invokeOperation 网关调用。
 * 关键依赖：registry.ts (defineOperation)、zod (schema 校验)
 *
 * 接线状态：
 * - 公告查询类（list/count/mark）：已接线至 announcements/actions 导出的纯函数
 * - 公告管理类（create/update/delete/toggle）：Bound at app level（逻辑内联于 server-action 闭包，含 revalidatePath/auditLog）
 * - 工单类（全部）：Bound at app level（逻辑内联于 server-action 闭包）
 */
import { z } from "zod";

import {
  countUnreadAnnouncementsForUser,
  markAnnouncementIdsReadForUser,
} from "../../announcements/actions";
import {
  adminAnnouncementListInputSchema,
  adminAnnouncementListOutputSchema,
  userAnnouncementListInputSchema,
  userAnnouncementListOutputSchema,
} from "../../announcements/list-contract";
import {
  markAllActiveAnnouncementsReadForUser,
  readAdminAnnouncementsPage,
  readUserAnnouncementsPage,
} from "../../announcements/list-service";
import { logError } from "../../logger";
import {
  DEFAULT_DASHBOARD_SUPPORT_CONFIG,
  dashboardSupportConfigSchema,
} from "../../support/dashboard-config";
import {
  markTicketSeenInputSchema,
  markTicketSeenOutputSchema,
  ticketListInputSchema,
  ticketListOutputSchema,
  ticketMessageListInputSchema,
  ticketMessageListOutputSchema,
} from "../../support/ticket-list-contract";
import {
  listTicketMessages,
  listTickets,
  markTicketSeen,
} from "../../support/ticket-list-service";
import { getRuntimeSettingJson } from "../../system-settings/index";
import { getPrincipalUserId } from "../principal";
import { defineOperation } from "../registry";

// ---------------------------------------------------------------------------
// Dashboard support configuration
// ---------------------------------------------------------------------------

/**
 * support.getDashboardConfiguration - 获取控制台支持区配置
 *
 * 权限：仅站内登录用户。返回值已经过共享 Zod 契约收窄，不暴露其他系统设置。
 * 历史脏值不会拖垮控制台，但会记录不包含配置正文的服务端错误并回退安全默认值。
 */
export const getDashboardConfiguration = defineOperation({
  name: "support.getDashboardConfiguration",
  domain: "support",
  title: "Get Dashboard Support Configuration",
  description:
    "获取控制台官方支持渠道和 Service & Support 入口的安全公开配置。",
  input: z.object({}),
  output: dashboardSupportConfigSchema,
  access: { kind: "user" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async () => {
    let value: unknown;
    try {
      value = await getRuntimeSettingJson("DASHBOARD_SUPPORT_CONFIG");
    } catch {
      logError(new Error("Dashboard support configuration cannot be read"), {
        source: "uol.support.get-dashboard-configuration",
      });
      return DEFAULT_DASHBOARD_SUPPORT_CONFIG;
    }
    if (value === undefined) return DEFAULT_DASHBOARD_SUPPORT_CONFIG;

    const parsed = dashboardSupportConfigSchema.safeParse(value);
    if (parsed.success) return parsed.data;

    logError(new Error("Dashboard support configuration is invalid"), {
      source: "uol.support.get-dashboard-configuration",
    });
    return DEFAULT_DASHBOARD_SUPPORT_CONFIG;
  },
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * support.createTicket - 用户创建客服工单
 *
 * 权限：protected（登录用户）
 * 副作用：email（通知管理员）
 * 幂等：none（允许重复创建不同工单）
 */
export const createTicket = defineOperation({
  name: "support.createTicket",
  domain: "support",
  title: "Create Support Ticket",
  description: "Create a new support ticket for the authenticated user.",
  input: z.object({
    subject: z.string().min(1).max(200),
    message: z.string().min(1).max(5000),
    category: z
      .enum(["bug", "feature", "billing", "account", "other"])
      .optional(),
  }),
  output: z.object({
    ticketId: z.string(),
    createdAt: z.string(),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["email"],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.createTicket");
  },
});

/**
 * support.getMyTickets - 获取当前用户的工单列表
 *
 * 权限：protected（登录用户）
 * 只读操作
 */
export const getMyTickets = defineOperation({
  name: "support.getMyTickets",
  domain: "support",
  title: "Get My Tickets",
  description: "分页读取当前人工会话用户的客服工单与精确总数。",
  input: ticketListInputSchema,
  output: ticketListOutputSchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: listTickets,
});

/**
 * support.getTicketDetail - 获取工单详情（用户侧）
 *
 * 权限：protected + owner（需校验工单归属）
 * 只读操作；标记已读由独立 operation 负责
 */
export const getTicketDetail = defineOperation({
  name: "support.getTicketDetail",
  domain: "support",
  title: "Get Ticket Detail",
  description: "分页读取本人客服工单详情和稳定排序的消息历史。",
  input: ticketMessageListInputSchema,
  output: ticketMessageListOutputSchema,
  access: { kind: "owner", resource: "ticket" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: listTicketMessages,
});

/** support.markMyTicketSeen - 独立更新本人查看时间，不受消息分页范围影响。 */
export const markMyTicketSeen = defineOperation({
  name: "support.markMyTicketSeen",
  domain: "support",
  title: "Mark My Ticket Seen",
  description: "将本人客服工单的全部既有客服动态标记为已读。",
  input: markTicketSeenInputSchema,
  output: markTicketSeenOutputSchema,
  access: { kind: "owner", resource: "ticket" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) =>
    markTicketSeen(input.ticketId, principal),
});

/**
 * support.addMessage - 用户在工单中追加消息
 *
 * 权限：protected + owner（需校验工单归属）
 * 副作用：email（通知管理员）
 */
export const addMessage = defineOperation({
  name: "support.addMessage",
  domain: "support",
  title: "Add Ticket Message",
  description:
    "Add a message to an existing ticket owned by the authenticated user.",
  input: z.object({
    ticketId: z.string().min(1),
    message: z.string().min(1).max(5000),
  }),
  output: z.object({
    messageId: z.string(),
    createdAt: z.string(),
  }),
  access: { kind: "owner", resource: "ticket" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["email"],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.addMessage");
  },
});

/**
 * support.getAllTickets - 管理员获取所有工单
 *
 * 权限：admin
 * 只读操作
 */
export const getAllTickets = defineOperation({
  name: "support.getAllTickets",
  domain: "support",
  title: "Get All Tickets (Admin)",
  description: "分页读取管理员可见的全站客服工单与精确总数。",
  input: ticketListInputSchema,
  output: ticketListOutputSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: listTickets,
});

/**
 * support.getAdminUnreadCount - 管理员未读工单计数
 *
 * 权限：admin
 * 只读操作
 */
export const getAdminUnreadCount = defineOperation({
  name: "support.getAdminUnreadCount",
  domain: "support",
  title: "Get Admin Unread Ticket Count",
  description: "Get the count of tickets with unread user messages for admin.",
  input: z.object({}),
  output: z.object({
    count: z.number().int().min(0),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.getAdminUnreadCount");
  },
});

/**
 * support.getMyUnreadCount - 用户未读消息计数
 *
 * 权限：protected（登录用户）
 * 只读操作
 */
export const getMyUnreadCount = defineOperation({
  name: "support.getMyUnreadCount",
  domain: "support",
  title: "Get My Unread Ticket Count",
  description:
    "Get the count of tickets with unread admin replies for the authenticated user.",
  input: z.object({}),
  output: z.object({
    count: z.number().int().min(0),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.getMyUnreadCount");
  },
});

/**
 * support.getAdminTicketDetail - 管理员查看工单详情
 *
 * 权限：admin
 * 只读操作；标记管理员已读由独立 operation 负责
 */
export const getAdminTicketDetail = defineOperation({
  name: "support.getAdminTicketDetail",
  domain: "support",
  title: "Get Admin Ticket Detail",
  description: "分页读取任意客服工单详情和稳定排序的消息历史。",
  input: ticketMessageListInputSchema,
  output: ticketMessageListOutputSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: listTicketMessages,
});

/** support.markAdminTicketSeen - 管理员一次标记工单全部用户动态已读。 */
export const markAdminTicketSeen = defineOperation({
  name: "support.markAdminTicketSeen",
  domain: "support",
  title: "Mark Admin Ticket Seen",
  description: "将指定客服工单的全部既有用户动态标记为管理员已读。",
  input: markTicketSeenInputSchema,
  output: markTicketSeenOutputSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) =>
    markTicketSeen(input.ticketId, principal),
});

/**
 * support.adminReply - 管理员回复工单
 *
 * 权限：admin
 * 副作用：email（通知用户）
 */
export const adminReply = defineOperation({
  name: "support.adminReply",
  domain: "support",
  title: "Admin Reply to Ticket",
  description: "Admin sends a reply message to a support ticket.",
  input: z.object({
    ticketId: z.string().min(1),
    message: z.string().min(1).max(5000),
  }),
  output: z.object({
    messageId: z.string(),
    createdAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: ["email"],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.adminReply");
  },
});

/**
 * support.updateTicketStatus - 管理员更新工单状态
 *
 * 权限：admin
 */
export const updateTicketStatus = defineOperation({
  name: "support.updateTicketStatus",
  domain: "support",
  title: "Update Ticket Status",
  description:
    "Admin updates the status of a support ticket (open/closed/pending).",
  input: z.object({
    ticketId: z.string().min(1),
    status: z.enum(["open", "in_progress", "resolved", "closed"]),
  }),
  output: z.object({
    ticketId: z.string(),
    status: z.string(),
    updatedAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: [],
  // Bound at app level - ticket logic inline in server-action
  execute: async () => {
    throw new Error("Not yet wired: support.updateTicketStatus");
  },
});

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * support.listAnnouncements - 用户获取活跃公告列表
 *
 * 权限：protected（登录用户）
 * 只读操作
 *
 * 已接线至公告分页服务，保留旧 Dashboard 摘要输出格式。
 */
export const listAnnouncements = defineOperation({
  name: "support.listAnnouncements",
  domain: "support",
  title: "List Active Announcements",
  description:
    "List all active (published) announcements visible to the authenticated user.",
  input: z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  }),
  output: z.object({
    announcements: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        publishedAt: z.string(),
        isRead: z.boolean(),
      })
    ),
    total: z.number(),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("Principal does not have a userId");
    }

    const result = await readUserAnnouncementsPage(userId, {
      page: _input.page ?? 1,
      pageSize: _input.pageSize ?? 50,
    });

    const announcements = result.records.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      publishedAt: row.publishedAt ?? row.createdAt,
      isRead: row.isRead,
    }));

    return { announcements, total: result.totalCount };
  },
});

/**
 * support.listMyAnnouncementPage - 用户完整公告页分页读取
 *
 * 权限：只接受真实站内用户 Principal；仅供人工页面使用，不进入 MCP。
 * 精确总数和当前页记录由领域服务在同一只读 repeatable-read 快照读取。
 */
export const listMyAnnouncementPage = defineOperation({
  name: "support.listMyAnnouncementPage",
  domain: "support",
  title: "List My Announcement Page",
  description: "读取当前登录用户可见的完整公告分页。",
  input: userAnnouncementListInputSchema,
  output: userAnnouncementListOutputSchema,
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("Principal does not have a userId");
    }
    return readUserAnnouncementsPage(userId, input);
  },
});

/**
 * support.countUnreadAnnouncements - 用户未读公告计数
 *
 * 权限：protected（登录用户）
 * 只读操作
 *
 * 已接线至 countUnreadAnnouncementsForUser 服务函数。
 */
export const countUnreadAnnouncements = defineOperation({
  name: "support.countUnreadAnnouncements",
  domain: "support",
  title: "Count Unread Announcements",
  description:
    "Get the count of unread announcements for the authenticated user.",
  input: z.object({}),
  output: z.object({
    count: z.number().int().min(0),
  }),
  access: { kind: "protected" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("Principal does not have a userId");
    }

    const count = await countUnreadAnnouncementsForUser(userId);
    return { count };
  },
});

/**
 * support.markAnnouncementRead - 标记单条公告为已读
 *
 * 权限：protected（登录用户）
 *
 * 已接线至 markAnnouncementIdsReadForUser 服务函数。
 */
export const markAnnouncementRead = defineOperation({
  name: "support.markAnnouncementRead",
  domain: "support",
  title: "Mark Announcement Read",
  description: "Mark a single announcement as read for the authenticated user.",
  input: z.object({
    announcementId: z.string().min(1),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "protected" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("Principal does not have a userId");
    }

    const marked = await markAnnouncementIdsReadForUser(userId, [
      input.announcementId,
    ]);
    return { success: marked > 0 };
  },
});

/**
 * support.markAllAnnouncementsRead - 标记所有公告为已读
 *
 * 权限：protected（登录用户）
 *
 * 已接线至单条 INSERT ... SELECT 集合写入，不读取全部公告 ID。
 */
export const markAllAnnouncementsRead = defineOperation({
  name: "support.markAllAnnouncementsRead",
  domain: "support",
  title: "Mark All Announcements Read",
  description: "Mark all announcements as read for the authenticated user.",
  input: z.object({}),
  output: z.object({
    success: z.boolean(),
    markedCount: z.number().int().min(0),
  }),
  access: { kind: "user" },
  agentExposure: "human-only",
  readOnly: false,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (_input, principal) => {
    const userId = getPrincipalUserId(principal);
    if (!userId) {
      throw new Error("Principal does not have a userId");
    }

    const markedCount = await markAllActiveAnnouncementsReadForUser(userId);
    return { success: true, markedCount };
  },
});

/**
 * support.getAdminAnnouncements - 管理员获取全部公告（含未发布）
 *
 * 权限：admin
 * 只读操作
 *
 * 已接线至公告分页服务，保留旧管理读取输出格式。
 */
export const getAdminAnnouncements = defineOperation({
  name: "support.getAdminAnnouncements",
  domain: "support",
  title: "Get Admin Announcements",
  description:
    "List all announcements (including unpublished) for admin management.",
  input: z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    published: z.boolean().optional(),
  }),
  output: z.object({
    announcements: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        isPublished: z.boolean(),
        publishedAt: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
    ),
    total: z.number(),
  }),
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => {
    const result = await readAdminAnnouncementsPage({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 100,
      published:
        input.published === undefined
          ? "all"
          : input.published
            ? "published"
            : "unpublished",
    });
    const announcements = result.records.map((row) => ({
      id: row.id,
      title: row.title,
      content: row.content,
      isPublished: row.isPublished,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

    return { announcements, total: result.totalCount };
  },
});

/**
 * support.listAdminAnnouncementPage - 管理公告页分页读取
 *
 * 权限：管理员；仅供人工管理页使用，不进入 MCP。管理统计独立于当前页和筛选，
 * 与筛选口径的精确总数、记录共同来自同一只读 repeatable-read 快照。
 */
export const listAdminAnnouncementPage = defineOperation({
  name: "support.listAdminAnnouncementPage",
  domain: "support",
  title: "List Admin Announcement Page",
  description: "读取管理员公告分页及全局统计。",
  input: adminAnnouncementListInputSchema,
  output: adminAnnouncementListOutputSchema,
  access: { kind: "admin" },
  agentExposure: "human-only",
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  execute: async (input) => readAdminAnnouncementsPage(input),
});

/**
 * support.createAnnouncement - 管理员创建公告
 *
 * 权限：admin
 */
export const createAnnouncement = defineOperation({
  name: "support.createAnnouncement",
  domain: "support",
  title: "Create Announcement",
  description: "Admin creates a new announcement.",
  input: z.object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(10000),
    isPublished: z.boolean().optional(),
  }),
  output: z.object({
    id: z.string(),
    createdAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: [],
  // Bound at app level - create logic inline in server-action (includes audit log + revalidatePath)
  execute: async () => {
    throw new Error("Not yet wired: support.createAnnouncement");
  },
});

/**
 * support.updateAnnouncement - 管理员更新公告
 *
 * 权限：admin
 */
export const updateAnnouncement = defineOperation({
  name: "support.updateAnnouncement",
  domain: "support",
  title: "Update Announcement",
  description: "Admin updates an existing announcement.",
  input: z.object({
    announcementId: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).max(10000).optional(),
  }),
  output: z.object({
    id: z.string(),
    updatedAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: [],
  // Bound at app level - update logic inline in server-action (includes audit log + revalidatePath)
  execute: async () => {
    throw new Error("Not yet wired: support.updateAnnouncement");
  },
});

/**
 * support.deleteAnnouncement - 管理员删除公告（不可逆）
 *
 * 权限：admin
 * 破坏性操作：agent 应二次确认
 */
export const deleteAnnouncement = defineOperation({
  name: "support.deleteAnnouncement",
  domain: "support",
  title: "Delete Announcement",
  description:
    "Admin permanently deletes an announcement. This action is irreversible.",
  input: z.object({
    announcementId: z.string().min(1),
  }),
  output: z.object({
    success: z.boolean(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: true,
  idempotency: { kind: "none" },
  sideEffects: [],
  // Bound at app level - delete logic inline in server-action (includes audit log + revalidatePath)
  execute: async () => {
    throw new Error("Not yet wired: support.deleteAnnouncement");
  },
});

/**
 * support.toggleAnnouncementPublish - 管理员切换公告发布状态
 *
 * 权限：admin
 */
export const toggleAnnouncementPublish = defineOperation({
  name: "support.toggleAnnouncementPublish",
  domain: "support",
  title: "Toggle Announcement Publish",
  description:
    "Admin toggles the published/unpublished state of an announcement.",
  input: z.object({
    announcementId: z.string().min(1),
    isPublished: z.boolean(),
  }),
  output: z.object({
    id: z.string(),
    isPublished: z.boolean(),
    updatedAt: z.string(),
  }),
  access: { kind: "admin" },
  readOnly: false,
  destructive: false,
  idempotency: { kind: "none" },
  sideEffects: [],
  // Bound at app level - toggle logic inline in server-action (includes audit log + revalidatePath)
  execute: async () => {
    throw new Error("Not yet wired: support.toggleAnnouncementPublish");
  },
});
