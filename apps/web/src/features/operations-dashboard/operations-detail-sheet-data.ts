/**
 * 运营总览明细 Sheet 的不可信响应校验与展示模型。
 *
 * 使用方：`operations-detail-sheet.tsx` 与其 DB-free 测试。模块将 UOL 的动态 record
 * 行收窄为封闭联合类型，再生成可直接渲染的列与单元格；不会接收或保留提示词、
 * 媒体链接、支付 provider payload 等核对范围外字段。
 */

import type { OperationsGetDetailInput } from "@repo/shared/operations-dashboard/contracts";
import {
  type OperationsDetailOutput,
  operationsDetailOutputSchema,
} from "@repo/shared/operations-dashboard/output-contracts";

import { formatPaymentAmount } from "@/features/payment/payment-display-format";

/** Sheet 只需要明细查询中的封闭 selection。 */
export type OperationsDetailSelection = OperationsGetDetailInput["selection"];

export type OperationsDetailSheetRow = OperationsDetailOutput["rows"][number];
export type OperationsGrowthDetailRow = Extract<
  OperationsDetailSheetRow,
  { retained: boolean | null }
>;
export type OperationsCommercialDetailRow = Extract<
  OperationsDetailSheetRow,
  { paymentOrderId: string }
>;
export type OperationsContentDetailRow = Extract<
  OperationsDetailSheetRow,
  { taskId: string }
>;

/** 经 selection 校验后的单页数据，供 Sheet 累加而不保留 unknown 行。 */
export type OperationsDetailPage = OperationsDetailOutput;

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

type OperationsDetailSelectionCopy = {
  title: string;
  description: string;
};

/**
 * 明细展示模型需要的全部本地化文本。
 *
 * 使用方：`operations-detail-sheet.tsx` 在当前 locale 下构造，DB-free 测试可注入固定
 * 文案；动态 Cohort 标题和秒数单位由调用方使用 ICU 规则完成，不在数据模块猜语言。
 */
export type OperationsDetailTableLabels = {
  selection: {
    cumulativeUsers: OperationsDetailSelectionCopy;
    users: OperationsDetailSelectionCopy;
    loginActivity: OperationsDetailSelectionCopy;
    creationActivity: OperationsDetailSelectionCopy;
    paymentActivity: OperationsDetailSelectionCopy;
    retentionCohorts: OperationsDetailSelectionCopy;
    orders: OperationsDetailSelectionCopy;
    fulfilledOrders: OperationsDetailSelectionCopy;
    paymentLifecycle: OperationsDetailSelectionCopy;
    imageOutputs: OperationsDetailSelectionCopy;
    videoOutputs: OperationsDetailSelectionCopy;
    creditUsage: OperationsDetailSelectionCopy;
  };
  columns: {
    user: string;
    email: string;
    role: string;
    accountStatus: string;
    businessTime: string;
    retention: string;
    order: string;
    tradeNumber: string;
    userId: string;
    amount: string;
    orderStatus: string;
    paymentEvent: string;
    createdAt: string;
    fulfilledAt: string;
    taskId: string;
    model: string;
    media: string;
    quantity: string;
    videoSeconds: string;
    netCredits: string;
  };
  values: {
    unnamedUser: string;
    banned: string;
    normal: string;
    retained: string;
    notRetained: string;
    image: string;
    video: string;
    seconds: (value: string) => string;
    emptyValue: string;
  };
  roles: {
    user: string;
    observer_admin: string;
    admin: string;
    super_admin: string;
  };
  orderStatus: Record<string, string>;
  paymentEvent: Record<string, string>;
};

/** 使用稳定 JSON 表达比较封闭 selection，不依赖对象引用。 */
function isSameSelection(
  left: OperationsDetailSelection,
  right: OperationsDetailSelection
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  return result.data;
}

/** 将 ISO 业务时间格式化到服务端回显的应用时区。 */
function formatDateTime(
  value: string | Date,
  locale: string,
  timeZone: string
) {
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

/** 使用本地化角色映射；未知角色保留数据库原值，便于管理员核对异常数据。 */
function formatRole(
  role: string,
  labels: OperationsDetailTableLabels["roles"]
): string {
  return role in labels ? labels[role as keyof typeof labels] : role;
}

/** 返回各 selection 的用户可见标题和口径说明。 */
function getSelectionCopy(
  selection: OperationsDetailSelection,
  labels: OperationsDetailTableLabels["selection"]
): OperationsDetailSelectionCopy {
  if (selection.module === "growth") {
    switch (selection.detail) {
      case "cumulative_users":
        return labels.cumulativeUsers;
      case "activity_bucket":
        return {
          new_users: labels.users,
          login: labels.loginActivity,
          creation: labels.creationActivity,
          payment: labels.paymentActivity,
        }[selection.activityKind];
      case "users":
        return labels.users;
      case "login_activity":
        return labels.loginActivity;
      case "creation_activity":
        return labels.creationActivity;
      case "payment_activity":
        return labels.paymentActivity;
      case "retention_cohorts":
        return labels.retentionCohorts;
    }
  }
  if (selection.module === "commercialization") {
    if (selection.detail === "orders") return labels.orders;
    if (selection.detail === "fulfilled_orders") {
      return labels.fulfilledOrders;
    }
    return labels.paymentLifecycle;
  }
  switch (selection.detail) {
    case "content_bucket":
      return {
        image: labels.imageOutputs,
        video: labels.videoOutputs,
        credits: labels.creditUsage,
      }[selection.contentKind];
    case "image_outputs":
      return labels.imageOutputs;
    case "video_outputs":
      return labels.videoOutputs;
    case "credit_usage":
      return labels.creditUsage;
  }
}

/** 将增长行转换为管理员核对表。 */
function buildGrowthTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string,
  labels: OperationsDetailTableLabels
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  const retentionDay =
    page.selection.module === "growth" &&
    page.selection.detail === "retention_cohorts"
      ? page.selection.retentionDay
      : null;
  const columns: OperationsDetailColumn[] = [
    { key: "user", label: labels.columns.user },
    { key: "email", label: labels.columns.email },
    { key: "role", label: labels.columns.role },
    { key: "status", label: labels.columns.accountStatus },
    { key: "businessTime", label: labels.columns.businessTime },
    ...(retentionDay
      ? [{ key: "retained", label: labels.columns.retention }]
      : []),
  ];
  return {
    columns,
    rows: (page.rows as OperationsGrowthDetailRow[]).map((row) => ({
      key: row.userId,
      cells: [
        `${row.name || labels.values.unnamedUser}\n${row.userId}`,
        row.email,
        formatRole(row.role, labels.roles),
        row.banned ? labels.values.banned : labels.values.normal,
        formatDateTime(row.businessTime, locale, timeZone),
        ...(retentionDay
          ? [row.retained ? labels.values.retained : labels.values.notRetained]
          : []),
      ],
    })),
  };
}

/** 将订单或支付事件行转换为管理员核对表。 */
function buildCommercialTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string,
  labels: OperationsDetailTableLabels
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  const isLifecycle =
    page.selection.module === "commercialization" &&
    (page.selection.detail === "payment_lifecycle" ||
      page.selection.detail === "payment_stage");
  return {
    columns: [
      { key: "order", label: labels.columns.order },
      { key: "trade", label: labels.columns.tradeNumber },
      { key: "user", label: labels.columns.userId },
      { key: "amount", label: labels.columns.amount, numeric: true },
      { key: "status", label: labels.columns.orderStatus },
      ...(isLifecycle
        ? [{ key: "event", label: labels.columns.paymentEvent }]
        : []),
      { key: "createdAt", label: labels.columns.createdAt },
      { key: "fulfilledAt", label: labels.columns.fulfilledAt },
      { key: "businessTime", label: labels.columns.businessTime },
    ],
    rows: (page.rows as OperationsCommercialDetailRow[]).map((row) => ({
      key: `${row.paymentOrderId}:${row.businessTime}:${row.eventType ?? "order"}`,
      cells: [
        row.paymentOrderId,
        row.providerTradeNo ?? labels.values.emptyValue,
        row.userId,
        formatPaymentAmount(row.amountMinor, row.currency, locale),
        labels.orderStatus[row.orderStatus] ?? row.orderStatus,
        ...(isLifecycle
          ? [
              row.eventType
                ? (labels.paymentEvent[row.eventType] ?? row.eventType)
                : labels.values.emptyValue,
            ]
          : []),
        formatDateTime(row.createdAt, locale, timeZone),
        row.fulfilledAt
          ? formatDateTime(row.fulfilledAt, locale, timeZone)
          : labels.values.emptyValue,
        formatDateTime(row.businessTime, locale, timeZone),
      ],
    })),
  };
}

/** 将成功图片、视频和积分关联行转换为管理员核对表。 */
function buildContentTableModel(
  page: OperationsDetailPage,
  locale: string,
  timeZone: string,
  labels: OperationsDetailTableLabels
): Pick<OperationsDetailTableModel, "columns" | "rows"> {
  return {
    columns: [
      { key: "task", label: labels.columns.taskId },
      { key: "user", label: labels.columns.userId },
      { key: "model", label: labels.columns.model },
      { key: "media", label: labels.columns.media },
      { key: "quantity", label: labels.columns.quantity, numeric: true },
      { key: "seconds", label: labels.columns.videoSeconds, numeric: true },
      { key: "credits", label: labels.columns.netCredits, numeric: true },
      { key: "businessTime", label: labels.columns.businessTime },
    ],
    rows: (page.rows as OperationsContentDetailRow[]).map((row) => ({
      key: `${row.mediaType}:${row.taskId}`,
      cells: [
        row.taskId,
        row.userId,
        row.model,
        row.mediaType === "image" ? labels.values.image : labels.values.video,
        row.quantity.toLocaleString(locale),
        labels.values.seconds(row.videoSeconds.toLocaleString(locale)),
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
 * @param labels 当前 locale 下完整的标题、列名、枚举值和单位文案。
 * @returns 稳定标题、口径、列及文本单元格；不产生 HTML。
 */
export function buildOperationsDetailTableModel(
  page: OperationsDetailPage,
  locale: string,
  labels: OperationsDetailTableLabels
): OperationsDetailTableModel {
  const copy = getSelectionCopy(page.selection, labels.selection);
  const timeZone = resolveTimeZone(page.range);
  const table =
    page.selection.module === "growth"
      ? buildGrowthTableModel(page, locale, timeZone, labels)
      : page.selection.module === "commercialization"
        ? buildCommercialTableModel(page, locale, timeZone, labels)
        : buildContentTableModel(page, locale, timeZone, labels);
  return { ...copy, ...table };
}
