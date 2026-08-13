/**
 * 运营总览 URL 查询适配。
 *
 * 使用方：运营总览 Server Component 和客户端筛选器。URL 只承载封闭的日期范围与
 * 趋势粒度，不把用户、时区、快照时间或内部查询字段暴露给调用方。
 */
import {
  type OperationsDashboardQueryInput,
  operationsDashboardQueryInputSchema,
  operationsGranularitySchema,
} from "@repo/shared/operations-dashboard/contracts";
import { operationsAppDateSchema } from "@repo/shared/operations-dashboard/facts-contracts";
import { z } from "zod";

export type OperationsDashboardSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type ParsedOperationsDashboardQuery = {
  input: OperationsDashboardQueryInput;
  invalidDeepLink: boolean;
  canonicalHref: string;
};

const querySchema = z
  .object({
    range: z
      .enum(["default", "this_week", "this_month", "this_year", "custom"])
      .optional(),
    from: operationsAppDateSchema.optional(),
    to: operationsAppDateSchema.optional(),
    granularity: operationsGranularitySchema.optional(),
  })
  .strict();

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

/** 解析运营总览 URL；未知、重复或非法参数统一回退默认查询。 */
export function parseOperationsDashboardSearchParams(
  params: OperationsDashboardSearchParams
): ParsedOperationsDashboardQuery {
  const fallback = createDefaultQuery();
  const parsedQuery = querySchema.safeParse(normalizeSearchParams(params));
  if (!parsedQuery.success) {
    return {
      input: fallback,
      invalidDeepLink: true,
      canonicalHref: buildOperationsDashboardHref(fallback),
    };
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
  if (!parsedInput.success || (rangeKind === "custom" && !range)) {
    return {
      input: fallback,
      invalidDeepLink: true,
      canonicalHref: buildOperationsDashboardHref(fallback),
    };
  }

  return {
    input: parsedInput.data,
    invalidDeepLink: false,
    canonicalHref: buildOperationsDashboardHref(parsedInput.data),
  };
}

/** 构造可分享的运营总览路径；默认范围和日粒度保持 URL 简洁。 */
export function buildOperationsDashboardHref(
  input: OperationsDashboardQueryInput
): string {
  const parsedInput = operationsDashboardQueryInputSchema.parse(input);
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
