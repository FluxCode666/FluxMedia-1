/**
 * 运营总览明细 Sheet 的不可信响应校验与展示模型。
 *
 * 使用方：`operations-detail-sheet.tsx` 与其 DB-free 测试。模块将 UOL 的动态 record
 * 行收窄为封闭联合类型，再生成可直接渲染的列与单元格；不会接收或保留提示词、
 * 媒体链接、支付 provider payload 等核对范围外字段。
 */

import { getUserRoleLabel } from "@repo/shared/auth/roles";
import { amountMinorToMajor } from "@repo/shared/credits/top-up";
import {
  type OperationsDetailOutput,
  type OperationsGetDetailInput,
  operationsDetailOutputSchema,
} from "@repo/shared/operations-dashboard/contracts";
import { z } from "zod";

/** Sheet 只需要明细查询中的封闭 selection。 */
export type OperationsDetailSelection = OperationsGetDetailInput["selection"];

const growthRowSchema = z
  .object({
    userId: z.string().min(1),
    name: z.string(),
    email: z.string().email(),
    role: z.string().min(1),
    banned: z.boolean(),
    businessTime: z.string().datetime({ offset: true }),
    retained: z.boolean().nullable(),
  })
  .strict();

const commercialRowSchema = z
  .object({
    paymentOrderId: z.string().min(1),
    providerTradeNo: z.string().nullable(),
    userId: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: z.number().int().nonnegative().safe(),
    orderStatus: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    fulfilledAt: z.string().datetime({ offset: true }).nullable(),
    businessTime: z.string().datetime({ offset: true }),
    eventType: z.string().nullable(),
  })
  .strict();

const contentRowSchema = z
  .object({
    taskId: z.string().min(1),
    userId: z.string().min(1),
    model: z.string().min(1),
    mediaType: z.enum(["image", "video"]),
    businessTime: z.string().datetime({ offset: true }),
    status: z.literal("completed"),
    quantity: z.number().int().positive().safe(),
    videoSeconds: z.number().int().nonnegative().safe(),
    netCredits: z.number().finite(),
  })
  .strict();

export type OperationsGrowthDetailRow = z.infer<typeof growthRowSchema>;
export type OperationsCommercialDetailRow = z.infer<typeof commercialRowSchema>;
export type OperationsContentDetailRow = z.infer<typeof contentRowSchema>;
export type OperationsDetailSheetRow =
  | OperationsGrowthDetailRow
  | OperationsCommercialDetailRow
  | OperationsContentDetailRow;

/** 经 selection 校验后的单页数据，供 Sheet 累加而不保留 unknown 行。 */
export type OperationsDetailPage = Omit<OperationsDetailOutput, "rows"> & {
  rows: OperationsDetailSheetRow[];
};

export type OperationsDetailColumn = {
  key: string;
  label: string;
  numeric?: boolean;
};

export type OperationsDetailTableRow = {
  key: string;
  cells: string[];
};

export type OperationsDetailTableModel = {
  title: string;
  description: string;
  columns: OperationsDetailColumn[];
  rows: OperationsDetailTableRow[];
};

/** 使用稳定 JSON 表达比较封闭 selection，不依赖对象引用。 */
function isSameSelection(
  left: OperationsDetailSelection,
  right: OperationsDetailSelection
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 按 selection 选择严格行 schema，拒绝任何额外或跨模块字段。 */
function parseRowsForSelection(
  selection: OperationsDetailSelection,
  rows: Record<string, unknown>[]
): OperationsDetailSheetRow[] {
  const schema =
    selection.module === "growth"
      ? growthRowSchema
      : selection.module === "commercialization"
        ? commercialRowSchema
        : contentRowSchema;
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw new Error("运营明细记录无效");
  return parsed.data;
}

/**
 * 校验 UOL 明细页及其 selection 绑定。
 *
 * @param value Server Action 返回的不可信数据。
 * @param expectedSelection 发起请求时的合法明细选择。
 * @returns 不包含 unknown 行的明细页。
 * @throws 外壳、选择或记录字段不符合契约时拒绝整页。
 */
export function parseOperationsDetailPage(
  value: unknown,
  expectedSelection: OperationsDetailSelection
): OperationsDetailPage {
  const result = operationsDetailOutputSchema.safeParse(value);
  if (!result.success) throw new Error("运营明细响应无效");
  if (!isSameSelection(result.data.selection, expectedSelection)) {
    throw new Error("运营明细选择不一致");
  }
  return {
    ...result.data,
    rows: parseRowsForSelection(result.data.selection, result.data.rows),
  };
}

/** 将 ISO 业务时间格式化到服务端回显的应用时区。 */
function formatDateTime(value: string, locale: string, timeZone: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
    timeZone,
  }).format(new Date(value));
}

/** 从动态 range DTO 中读取已校验的应用时区，异常值回退 UTC。 */
function resolveTimeZone(range: Record<string, unknown>): string {
  return typeof range.timeZone === "string" && range.timeZone.length > 0
    ? range.timeZone
    : "UTC";
}

/** 本地化最小货币单位；未知币种仍保留原币种和精确主单位。 */
function formatAmount(
  amountMinor: number,
  currency: string,
  locale: string
): string {
  const amount = amountMinorToMajor(amountMinor, currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 3,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(locale)}`;
  }
}

/** 将数据库角色转换为管理员熟悉的中文标签，未知角色仍原样展示便于核对。 */
function formatRole(role: string): string {
  return ["user", "observer_admin", "admin", "super_admin"].includes(role)
    ? getUserRoleLabel(role)
    : role;
}

const PAYMENT_EVENT_LABELS: Record<string, string> = {
  order_created: "订单已创建",
  checkout_ready: "结账已就绪",
  payment_confirmed: "支付已确认",
  fulfillment_succeeded: "履约成功",
  checkout_failed: "结账失败",
  fulfillment_attempt_failed: "履约尝试失败",
  fulfillment_failed_terminal: "履约终止失败",
  expired: "已过期",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "待支付",
  paid: "已支付",
  fulfilled: "已履约",
  failed: "失败",
  expired: "已过期",
};

/** 返回各 selection 的用户可见标题和口径说明。 */
function getSelectionCopy(selection: OperationsDetailSelection): {
  title: string;
  description: string;
} {
  if (selection.module === "growth") {
    switch (selection.detail) {
      case "users":
        return {
          title: "新增用户明细",
          description: "按注册业务时间列出范围内新增账户。",
        };
      case "login_activity":
        return {
          title: "登录活跃用户明细",
          description: "每位范围内实际访问平台的用户只列一行。",
        };
      case "creation_activity":
        return {
          title: "创作活跃用户明细",
          description: "每位范围内成功生图或生视频的用户只列一行。",
        };
      case "payment_activity":
        return {
          title: "付费活跃用户明细",
          description: "每位范围内成功充值的用户只列一行。",
        };
      case "retention_cohorts":
        return {
          title: `${selection.cohortDate} Cohort D${selection.retentionDay} 明细`,
          description: `核对注册日用户在第 ${selection.retentionDay} 个自然日当天是否成功创作。`,
        };
    }
  }
  if (selection.module === "commercialization") {
    return selection.detail === "orders"
      ? {
          title: "订单明细",
          description: "按订单创建业务时间核对充值订单，不含线下退款。",
        }
      : {
          title: "支付生命周期明细",
          description: "按不可变支付事件核对订单创建、支付和履约阶段。",
        };
  }
  switch (selection.detail) {
    case "image_outputs":
      return {
        title: "生图明细",
        description: "仅列成功图片产物，不包含提示词或媒体链接。",
      };
    case "video_outputs":
      return {
        title: "视频明细",
        description: "仅列成功视频产物及视频秒数。",
      };
    case "credit_usage":
      return {
        title: "成功积分净用量明细",
        description: "按成功产物稳定关联后的实际净积分核对。",
      };
  }
}

/** 将增长行转换为管理员核对表。 */
function buildGrowthTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  const retentionDay =
    page.selection.module === "growth" &&
    page.selection.detail === "retention_cohorts"
      ? page.selection.retentionDay
      : null;
  const columns: OperationsDetailColumn[] = [
    { key: "user", label: "用户" },
    { key: "email", label: "完整邮箱" },
    { key: "role", label: "角色" },
    { key: "status", label: "账号状态" },
    { key: "businessTime", label: "业务时间" },
    ...(retentionDay
      ? [{ key: "retained", label: `D${retentionDay} 留存` }]
      : []),
  ];
  return {
    columns,
    rows: (page.rows as OperationsGrowthDetailRow[]).map((row) => ({
      key: row.userId,
      cells: [
        `${row.name || "未命名用户"}\n${row.userId}`,
        row.email,
        formatRole(row.role),
        row.banned ? "已封禁" : "正常",
        formatDateTime(row.businessTime, locale, timeZone),
        ...(retentionDay ? [row.retained ? "已留存" : "未留存"] : []),
      ],
    })),
  };
}

/** 将订单或支付事件行转换为管理员核对表。 */
function buildCommercialTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  const isLifecycle =
    page.selection.module === "commercialization" &&
    page.selection.detail === "payment_lifecycle";
  return {
    columns: [
      { key: "order", label: "平台订单" },
      { key: "trade", label: "渠道交易号" },
      { key: "user", label: "用户 ID" },
      { key: "amount", label: "金额", numeric: true },
      { key: "status", label: "订单状态" },
      ...(isLifecycle ? [{ key: "event", label: "支付事件" }] : []),
      { key: "createdAt", label: "创建时间" },
      { key: "fulfilledAt", label: "履约时间" },
      { key: "businessTime", label: "业务时间" },
    ],
    rows: (page.rows as OperationsCommercialDetailRow[]).map((row) => ({
      key: `${row.paymentOrderId}:${row.businessTime}:${row.eventType ?? "order"}`,
      cells: [
        row.paymentOrderId,
        row.providerTradeNo ?? "—",
        row.userId,
        formatAmount(row.amountMinor, row.currency, locale),
        ORDER_STATUS_LABELS[row.orderStatus] ?? row.orderStatus,
        ...(isLifecycle
          ? [
              row.eventType
                ? (PAYMENT_EVENT_LABELS[row.eventType] ?? row.eventType)
                : "—",
            ]
          : []),
        formatDateTime(row.createdAt, locale, timeZone),
        row.fulfilledAt
          ? formatDateTime(row.fulfilledAt, locale, timeZone)
          : "—",
        formatDateTime(row.businessTime, locale, timeZone),
      ],
    })),
  };
}

/** 将成功图片、视频和积分关联行转换为管理员核对表。 */
function buildContentTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  return {
    columns: [
      { key: "task", label: "任务 ID" },
      { key: "user", label: "用户 ID" },
      { key: "model", label: "模型" },
      { key: "media", label: "媒体" },
      { key: "quantity", label: "数量", numeric: true },
      { key: "seconds", label: "视频秒数", numeric: true },
      { key: "credits", label: "净积分", numeric: true },
      { key: "businessTime", label: "业务时间" },
    ],
    rows: (page.rows as OperationsContentDetailRow[]).map((row) => ({
      key: `${row.mediaType}:${row.taskId}`,
      cells: [
        row.taskId,
        row.userId,
        row.model,
        row.mediaType === "image" ? "图片" : "视频",
        row.quantity.toLocaleString(locale),
        `${row.videoSeconds.toLocaleString(locale)} 秒`,
        row.netCredits.toLocaleString(locale, {
          maximumFractionDigits: 2,
        }),
        formatDateTime(row.businessTime, locale, timeZone),
      ],
    })),
  };
}

/**
 * 将校验后的单页或累计页转换为可访问表格模型。
 *
 * @param page 当前 selection 下累计的安全记录。
 * @param locale 管理员页面 locale。
 * @returns 稳定标题、口径、列及文本单元格；不产生 HTML。
 */
export function buildOperationsDetailTableModel(
  page: OperationsDetailPage,
  locale: string
): OperationsDetailTableModel {
  const copy = getSelectionCopy(page.selection);
  const timeZone = resolveTimeZone(page.range);
  const table =
    page.selection.module === "growth"
      ? buildGrowthTableModel(page, locale, timeZone)
      : page.selection.module === "commercialization"
        ? buildCommercialTableModel(page, locale, timeZone)
        : buildContentTableModel(page, locale, timeZone);
  return { ...copy, ...table };
}
