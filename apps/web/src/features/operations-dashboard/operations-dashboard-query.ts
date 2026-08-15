/**
 * 运营总览 URL 查询适配。
 *
 * 使用方：运营总览 Server Component 和客户端筛选器。URL 只承载封闭的日期范围与
 * 趋势粒度，不把用户、时区、快照时间或内部查询字段暴露给调用方。
 */
import {
  type OperationsDashboardQueryInput,
  type OperationsDetailSelection,
  operationsDashboardQueryInputSchema,
  operationsDetailSelectionSchema,
  operationsGranularitySchema,
  operationsPaymentLifecycleStageSchema,
} from "@repo/shared/operations-dashboard/contracts";
import { operationsAppDateSchema } from "@repo/shared/operations-dashboard/facts-contracts";
import { z } from "zod";

export type OperationsDashboardSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type ParsedOperationsDashboardQuery = {
  input: OperationsDashboardQueryInput;
  detailSelection: OperationsDetailSelection | null;
  invalidDeepLink: boolean;
  canonicalHref: string;
};

const detailBucketParameterSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/);

const querySchema = z
  .object({
    range: z
      .enum(["default", "this_week", "this_month", "this_year", "custom"])
      .optional(),
    from: operationsAppDateSchema.optional(),
    to: operationsAppDateSchema.optional(),
    granularity: operationsGranularitySchema.optional(),
    detail: z.string().trim().min(1).max(100).optional(),
    cutoffDate: operationsAppDateSchema.optional(),
    activityKind: z
      .enum(["new_users", "login", "creation", "payment"])
      .optional(),
    bucket: detailBucketParameterSchema.optional(),
    cohortDate: operationsAppDateSchema.optional(),
    retentionDay: z.enum(["1", "7", "30"]).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    stage: operationsPaymentLifecycleStageSchema.optional(),
    contentKind: z.enum(["image", "video", "credits"]).optional(),
  })
  .strict();

type ParsedQueryParameters = z.infer<typeof querySchema>;
type DetailParameterKey = Exclude<
  keyof ParsedQueryParameters,
  "range" | "from" | "to" | "granularity"
>;

const DETAIL_PARAMETER_KEYS: readonly DetailParameterKey[] = [
  "detail",
  "cutoffDate",
  "activityKind",
  "bucket",
  "cohortDate",
  "retentionDay",
  "currency",
  "stage",
  "contentKind",
];

/** 将 Next.js searchParams 的单值读取为字符串，重复参数保留为非法输入。 */
function normalizeSearchParams(
  params: OperationsDashboardSearchParams
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(params));
}

/** 创建已通过共享 schema 规范化的默认查询。 */
function createDefaultQuery(): OperationsDashboardQueryInput {
  return operationsDashboardQueryInputSchema.parse({});
}

/** 判断明细深链是否只携带当前 selection 允许的参数。 */
function hasOnlyDetailParameters(
  value: ParsedQueryParameters,
  allowed: readonly DetailParameterKey[]
): boolean {
  return DETAIL_PARAMETER_KEYS.every(
    (key) => value[key] === undefined || allowed.includes(key)
  );
}

/** 把单值 bucket 参数还原为共享契约的闭区间自然日。 */
function parseDetailBucket(
  value: string | undefined
): { from: string; to: string } | null {
  if (!value) return null;
  const [from, to, extra] = value.split("_");
  if (extra !== undefined) return null;
  const parsed = z
    .object({
      from: operationsAppDateSchema,
      to: operationsAppDateSchema,
    })
    .strict()
    .safeParse({ from, to });
  return parsed.success && parsed.data.from <= parsed.data.to
    ? parsed.data
    : null;
}

/** 从白名单平铺参数构造封闭 detail selection；非法组合返回失败标记。 */
function parseDetailSelection(value: ParsedQueryParameters): {
  selection: OperationsDetailSelection | null;
  valid: boolean;
} {
  if (!value.detail) {
    return {
      selection: null,
      valid: hasOnlyDetailParameters(value, []),
    };
  }
  const bucket = parseDetailBucket(value.bucket);
  let candidate: unknown;
  let allowed: readonly DetailParameterKey[];
  switch (value.detail) {
    case "cumulative_users":
      candidate = {
        module: "growth",
        detail: value.detail,
        cutoffDate: value.cutoffDate,
      };
      allowed = ["detail", "cutoffDate"];
      break;
    case "users":
    case "login_activity":
    case "creation_activity":
    case "payment_activity":
      candidate = { module: "growth", detail: value.detail };
      allowed = ["detail"];
      break;
    case "activity_bucket":
      candidate = {
        module: "growth",
        detail: value.detail,
        activityKind: value.activityKind,
        bucket,
      };
      allowed = ["detail", "activityKind", "bucket"];
      break;
    case "retention_cohorts":
      candidate = {
        module: "growth",
        detail: value.detail,
        cohortDate: value.cohortDate,
        retentionDay: value.retentionDay
          ? Number(value.retentionDay)
          : undefined,
      };
      allowed = ["detail", "cohortDate", "retentionDay"];
      break;
    case "orders":
    case "payment_lifecycle":
      candidate = { module: "commercialization", detail: value.detail };
      allowed = ["detail"];
      break;
    case "fulfilled_orders":
      candidate = {
        module: "commercialization",
        detail: value.detail,
        ...(value.currency ? { currency: value.currency } : {}),
      };
      allowed = ["detail", "currency"];
      break;
    case "payment_stage":
      candidate = {
        module: "commercialization",
        detail: value.detail,
        stage: value.stage,
        ...(value.currency ? { currency: value.currency } : {}),
      };
      allowed = ["detail", "stage", "currency"];
      break;
    case "image_outputs":
    case "video_outputs":
    case "credit_usage":
      candidate = { module: "content", detail: value.detail };
      allowed = ["detail"];
      break;
    case "content_bucket":
      candidate = {
        module: "content",
        detail: value.detail,
        contentKind: value.contentKind,
        bucket,
      };
      allowed = ["detail", "contentKind", "bucket"];
      break;
    default:
      return { selection: null, valid: false };
  }
  const parsed = operationsDetailSelectionSchema.safeParse(candidate);
  return {
    selection: parsed.success ? parsed.data : null,
    valid: parsed.success && hasOnlyDetailParameters(value, allowed),
  };
}

/** 创建统一非法深链结果，避免不同失败分支遗漏 canonical 清理。 */
function createInvalidDeepLinkResult(
  fallback: OperationsDashboardQueryInput
): ParsedOperationsDashboardQuery {
  return {
    input: fallback,
    detailSelection: null,
    invalidDeepLink: true,
    canonicalHref: buildOperationsDashboardHref(fallback),
  };
}

/** 解析运营总览 URL；未知、重复或非法参数统一回退默认查询。 */
export function parseOperationsDashboardSearchParams(
  params: OperationsDashboardSearchParams
): ParsedOperationsDashboardQuery {
  const fallback = createDefaultQuery();
  const parsedQuery = querySchema.safeParse(normalizeSearchParams(params));
  if (!parsedQuery.success) {
    return createInvalidDeepLinkResult(fallback);
  }

  const value = parsedQuery.data;
  const rangeKind = value.range ?? "default";
  const range =
    rangeKind === "custom"
      ? value.from && value.to
        ? { kind: "custom" as const, from: value.from, to: value.to }
        : null
      : { kind: rangeKind };
  const parsedInput = operationsDashboardQueryInputSchema.safeParse({
    granularity: value.granularity,
    ...(range ? { range } : {}),
  });
  const parsedDetail = parseDetailSelection(value);
  if (
    !parsedInput.success ||
    (rangeKind === "custom" && !range) ||
    !parsedDetail.valid
  ) {
    return createInvalidDeepLinkResult(fallback);
  }

  return {
    input: parsedInput.data,
    detailSelection: parsedDetail.selection,
    invalidDeepLink: false,
    canonicalHref: buildOperationsDashboardHref(
      parsedInput.data,
      parsedDetail.selection
    ),
  };
}

/** 把封闭明细 selection 追加为稳定、有序且可分享的 URL 参数。 */
function appendDetailSearchParams(
  search: URLSearchParams,
  selection: OperationsDetailSelection
): void {
  search.set("detail", selection.detail);
  if (selection.detail === "cumulative_users") {
    search.set("cutoffDate", selection.cutoffDate);
  } else if (selection.detail === "activity_bucket") {
    search.set("activityKind", selection.activityKind);
    search.set("bucket", `${selection.bucket.from}_${selection.bucket.to}`);
  } else if (selection.detail === "retention_cohorts") {
    search.set("cohortDate", selection.cohortDate);
    search.set("retentionDay", String(selection.retentionDay));
  } else if (selection.detail === "fulfilled_orders") {
    if (selection.currency) search.set("currency", selection.currency);
  } else if (selection.detail === "payment_stage") {
    search.set("stage", selection.stage);
    if (selection.currency) search.set("currency", selection.currency);
  } else if (selection.detail === "content_bucket") {
    search.set("contentKind", selection.contentKind);
    search.set("bucket", `${selection.bucket.from}_${selection.bucket.to}`);
  }
}

/** 构造可分享的运营总览路径；可选明细与当前筛选共享同一 canonical URL。 */
export function buildOperationsDashboardHref(
  input: OperationsDashboardQueryInput,
  detailSelection: OperationsDetailSelection | null = null
): string {
  const parsedInput = operationsDashboardQueryInputSchema.parse(input);
  const parsedDetail = detailSelection
    ? operationsDetailSelectionSchema.parse(detailSelection)
    : null;
  const search = new URLSearchParams();
  if (parsedInput.range.kind !== "default") {
    search.set("range", parsedInput.range.kind);
    if (parsedInput.range.kind === "custom") {
      search.set("from", parsedInput.range.from);
      search.set("to", parsedInput.range.to);
    }
  }
  if (parsedInput.granularity !== "day") {
    search.set("granularity", parsedInput.granularity);
  }
  if (parsedDetail) appendDetailSearchParams(search, parsedDetail);
  const query = search.toString();
  return query
    ? `/dashboard/admin/operations?${query}`
    : "/dashboard/admin/operations";
}

/** 从服务端实际范围还原可提交的自定义范围，并保留当前趋势粒度。 */
export function queryFromOperationsRange(range: {
  granularity: "day" | "week" | "month";
  from: string;
  to: string;
}): OperationsDashboardQueryInput {
  return operationsDashboardQueryInputSchema.parse({
    granularity: range.granularity,
    range: { kind: "custom", from: range.from, to: range.to },
  });
}
