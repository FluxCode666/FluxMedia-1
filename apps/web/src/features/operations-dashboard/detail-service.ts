/**
 * 运营总览管理员明细应用服务。
 *
 * 使用方：operations.getDetail UOL binding 与后续 CSV worker。服务在单一只读
 * repeatable-read 快照中解析应用时区范围、验证筛选绑定的 HMAC cursor，并把
 * 增长事实收敛为可核对但不包含提示词、媒体链接或支付凭据的安全行。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { OperationsGetDetailInput } from "@repo/shared/operations-dashboard/contracts";
import { operationsGetDetailInputSchema } from "@repo/shared/operations-dashboard/contracts";
import type { OperationsDetailOutput } from "@repo/shared/operations-dashboard/output-contracts";
import {
  addOperationsCalendarDays,
  resolveOperationsDashboardRange,
} from "@repo/shared/operations-dashboard/range";
import { parseDateInputInTimeZone } from "@repo/shared/time-zone";
import { z } from "zod";

import {
  databaseOperationsGrowthDetailRepository,
  type OperationsCommercialDetailRow,
  type OperationsContentDetailRow,
  type OperationsDetailCursor,
  type OperationsDetailQuery,
  type OperationsDetailRepository,
  type OperationsDetailRow,
  type OperationsGrowthDetailQuery,
  type OperationsGrowthDetailRow,
  paginateOperationsDetailRows,
} from "./detail-repository";

type OperationsDetailOutputRow = OperationsDetailOutput["rows"][number];

const DETAIL_CURSOR_VERSION = 1;
const DETAIL_CURSOR_DOMAIN = "fluxmedia:operations-detail:cursor:v1";
const DETAIL_FILTER_DOMAIN = "fluxmedia:operations-detail:filters:v1";
const MAX_CURSOR_LENGTH = 4096;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const detailCursorPayloadSchema = z
  .object({
    v: z.literal(DETAIL_CURSOR_VERSION),
    sub: z.string().min(1).max(512),
    filter: z.string().length(43),
    asOf: z.string().datetime({ offset: true }),
    sortKey: z
      .object({
        businessTime: z.string().datetime({ offset: true }),
        stableId: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

/** 运营明细服务可稳定映射到 UOL 的错误分类。 */
export type OperationsDetailServiceErrorCode =
  | "validation_error"
  | "not_ready"
  | "not_implemented"
  | "invalid_data";

/** 不携带 cursor、邮箱、SQL 或数据库行的明细领域错误。 */
export class OperationsDetailServiceError extends Error {
  /** 创建可由 UOL binding 稳定映射的明细错误。 */
  constructor(
    readonly code: OperationsDetailServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OperationsDetailServiceError";
  }
}

/** 明细服务的依赖；测试可注入 DB-free 仓储和固定 cursor 密钥。 */
export type OperationsDetailServiceDependencies = {
  repository: OperationsDetailRepository;
  tokenSecret?: string;
};

/** 获取测试注入或生产认证密钥；缺失时禁止签发可篡改的管理员 cursor。 */
function resolveCursorSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!value?.trim()) {
    throw new OperationsDetailServiceError(
      "not_ready",
      "运营明细游标密钥尚未配置"
    );
  }
  return value;
}

/** 把日期、粒度和明细选择规范化为固定长度筛选指纹。 */
function fingerprintDetailFilters(
  input: OperationsGetDetailInput,
  secret: string
): string {
  const filter = {
    granularity: input.granularity,
    range: input.range,
    selection: input.selection,
  };
  return createHmac("sha256", secret)
    .update(DETAIL_FILTER_DOMAIN)
    .update("\0")
    .update(JSON.stringify(filter))
    .digest("base64url");
}

/** 使用独立域标签签名运营明细 cursor，禁止跨接口复用。 */
function signDetailCursorPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(DETAIL_CURSOR_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 签发绑定管理员、筛选、快照上限和完整排序键的不透明 cursor。 */
function encodeOperationsDetailCursor(
  input: {
    actorUserId: string;
    filters: OperationsGetDetailInput;
    asOf: Date;
    sortKey: OperationsDetailCursor;
  },
  secret?: string
): string {
  const resolvedSecret = resolveCursorSecret(secret);
  const payload = detailCursorPayloadSchema.parse({
    v: DETAIL_CURSOR_VERSION,
    sub: input.actorUserId,
    filter: fingerprintDetailFilters(input.filters, resolvedSecret),
    asOf: input.asOf.toISOString(),
    sortKey: {
      businessTime: input.sortKey.businessTime.toISOString(),
      stableId: input.sortKey.stableId,
    },
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signDetailCursorPayload(
    encodedPayload,
    resolvedSecret
  ).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

/** 验证 cursor 的格式、签名、管理员、筛选和排序键快照边界。 */
function decodeOperationsDetailCursor(
  token: string,
  expected: {
    actorUserId: string;
    filters: OperationsGetDetailInput;
    asOfNotAfter: Date;
  },
  secret?: string
): { asOf: Date; sortKey: OperationsDetailCursor } {
  try {
    if (!token || token.length > MAX_CURSOR_LENGTH) {
      throw new OperationsDetailServiceError(
        "validation_error",
        "运营明细游标无效"
      );
    }
    const [payloadPart, signaturePart, extraPart] = token.split(".");
    if (
      !payloadPart ||
      !signaturePart ||
      extraPart !== undefined ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new OperationsDetailServiceError(
        "validation_error",
        "运营明细游标无效"
      );
    }
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    const signatureBytes = Buffer.from(signaturePart, "base64url");
    if (
      payloadBytes.toString("base64url") !== payloadPart ||
      signatureBytes.toString("base64url") !== signaturePart
    ) {
      throw new OperationsDetailServiceError(
        "validation_error",
        "运营明细游标无效"
      );
    }
    const resolvedSecret = resolveCursorSecret(secret);
    const expectedSignature = signDetailCursorPayload(
      payloadPart,
      resolvedSecret
    );
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new OperationsDetailServiceError(
        "validation_error",
        "运营明细游标无效"
      );
    }
    const payload = detailCursorPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    const expectedFilter = fingerprintDetailFilters(
      expected.filters,
      resolvedSecret
    );
    const actualFilterBytes = Buffer.from(payload.filter);
    const expectedFilterBytes = Buffer.from(expectedFilter);
    const asOf = new Date(payload.asOf);
    const businessTime = new Date(payload.sortKey.businessTime);
    if (
      payload.sub !== expected.actorUserId ||
      actualFilterBytes.length !== expectedFilterBytes.length ||
      !timingSafeEqual(actualFilterBytes, expectedFilterBytes) ||
      asOf > expected.asOfNotAfter ||
      businessTime > asOf
    ) {
      throw new OperationsDetailServiceError(
        "validation_error",
        "运营明细游标无效"
      );
    }
    return {
      asOf,
      sortKey: { businessTime, stableId: payload.sortKey.stableId },
    };
  } catch (error) {
    if (error instanceof OperationsDetailServiceError) throw error;
    throw new OperationsDetailServiceError(
      "validation_error",
      "运营明细游标无效"
    );
  }
}

/** 把应用日期解析为时区零点，失败统一收敛为明细范围校验错误。 */
function requireAppDateStart(value: string, timeZone: string): Date {
  const result = parseDateInputInTimeZone(value, { timeZone });
  if (!result) {
    throw new OperationsDetailServiceError(
      "validation_error",
      "运营明细日期范围无效"
    );
  }
  return result;
}

/** 将增长明细选择映射为同源仓储查询，Cohort 只接受已成熟单元格。 */
function buildGrowthDetailQuery(input: {
  parsed: OperationsGetDetailInput;
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  timeZone: string;
  cursor: OperationsDetailCursor | null;
}): OperationsGrowthDetailQuery {
  const base = {
    start: input.start,
    end: input.end,
    epochStart: input.epochStart,
    asOf: input.asOf,
    cursor: input.cursor,
    limit: input.parsed.limit + 1,
  };
  const selection = input.parsed.selection;
  if (selection.module !== "growth") {
    throw new OperationsDetailServiceError(
      "not_implemented",
      "该运营明细类型尚未接入"
    );
  }
  switch (selection.detail) {
    case "users":
      return { ...base, kind: "users" };
    case "login_activity":
      return { ...base, kind: "activity", activityKind: "login" };
    case "creation_activity":
      return { ...base, kind: "activity", activityKind: "creation" };
    case "payment_activity":
      return { ...base, kind: "activity", activityKind: "payment" };
    case "retention_cohorts":
      break;
  }
  const cohortDate = selection.cohortDate;
  const retentionDay = selection.retentionDay;
  if (cohortDate === undefined || retentionDay === undefined) {
    throw new OperationsDetailServiceError(
      "validation_error",
      "Cohort 明细参数不完整"
    );
  }
  const cohortStart = requireAppDateStart(cohortDate, input.timeZone);
  const cohortEnd = requireAppDateStart(
    addOperationsCalendarDays(cohortDate, 1),
    input.timeZone
  );
  const targetDate = addOperationsCalendarDays(cohortDate, retentionDay);
  const targetStart = requireAppDateStart(targetDate, input.timeZone);
  const targetEnd = requireAppDateStart(
    addOperationsCalendarDays(targetDate, 1),
    input.timeZone
  );
  if (
    cohortStart < input.start ||
    cohortStart >= input.end ||
    cohortStart < input.epochStart ||
    targetStart > input.asOf
  ) {
    throw new OperationsDetailServiceError(
      "validation_error",
      "Cohort 明细不属于当前范围或尚未成熟"
    );
  }
  return {
    ...base,
    kind: "cohort",
    start: cohortStart,
    end: cohortEnd,
    targetStart,
    targetEnd: targetEnd > input.asOf ? input.asOf : targetEnd,
  };
}

/** 将模块选择映射为增长、商业化或内容的同源明细查询。 */
function buildDetailQuery(input: {
  parsed: OperationsGetDetailInput;
  start: Date;
  end: Date;
  epochStart: Date;
  asOf: Date;
  timeZone: string;
  cursor: OperationsDetailCursor | null;
}): OperationsDetailQuery {
  if (input.parsed.selection.module === "growth") {
    return buildGrowthDetailQuery(input);
  }
  const base = {
    start: input.start,
    end: input.end,
    epochStart: input.epochStart,
    asOf: input.asOf,
    cursor: input.cursor,
    limit: input.parsed.limit + 1,
  };
  if (input.parsed.selection.module === "commercialization") {
    return { ...base, kind: input.parsed.selection.detail };
  }
  return {
    ...base,
    kind: "content",
    detail: input.parsed.selection.detail,
  };
}

/** 把数据库 Date 转成可跨 UOL 传输的明细行。 */
function adaptGrowthDetailRow(
  row: OperationsGrowthDetailRow
): OperationsDetailOutputRow {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: row.role,
    banned: row.banned,
    businessTime: row.businessTime.toISOString(),
    retained: row.retained,
  };
}

/** 把商业化日期转换为传输安全字段，不暴露 provider payload。 */
function adaptCommercialDetailRow(
  row: OperationsCommercialDetailRow
): OperationsDetailOutputRow {
  return {
    paymentOrderId: row.paymentOrderId,
    providerTradeNo: row.providerTradeNo,
    userId: row.userId,
    currency: row.currency,
    amountMinor: row.amountMinor,
    orderStatus: row.orderStatus,
    createdAt: row.createdAt.toISOString(),
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    businessTime: row.businessTime.toISOString(),
    eventType: row.eventType,
  };
}

/** 把成功产物转换为不含提示词、媒体链接的传输安全字段。 */
function adaptContentDetailRow(
  row: OperationsContentDetailRow
): OperationsDetailOutputRow {
  return {
    taskId: row.taskId,
    userId: row.userId,
    model: row.model,
    mediaType: row.mediaType,
    businessTime: row.businessTime.toISOString(),
    status: row.status,
    quantity: row.quantity,
    videoSeconds: row.videoSeconds,
    netCredits: row.netCredits,
  };
}

/** 根据封闭行类型选择安全传输适配器。 */
function adaptDetailRow(row: OperationsDetailRow): OperationsDetailOutputRow {
  if ("taskId" in row) return adaptContentDetailRow(row);
  if ("paymentOrderId" in row) return adaptCommercialDetailRow(row);
  return adaptGrowthDetailRow(row);
}

/**
 * 读取一页运营明细。
 *
 * @param request 已验证管理员身份、部署时区与不可信 operation 输入。
 * @param dependencies 可替换的只读仓储和 cursor 密钥。
 * @returns 与筛选范围同源的增长、商业化或内容明细及下一页签名 cursor。
 * @sideEffects 只开启一个只读 repeatable-read 事务。
 * @failure 未初始化 epoch 返回 not_ready，数据关联漂移返回 invalid_data。
 */
export async function loadOperationsDetail(
  request: {
    actorUserId: string;
    timeZone: string;
    input: unknown;
  },
  dependencies: OperationsDetailServiceDependencies = {
    repository: databaseOperationsGrowthDetailRepository,
  }
): Promise<OperationsDetailOutput> {
  const parsedResult = operationsGetDetailInputSchema.safeParse(request.input);
  if (!parsedResult.success) {
    throw new OperationsDetailServiceError(
      "validation_error",
      "运营明细查询参数无效"
    );
  }
  const parsed = parsedResult.data;
  const actorUserId = request.actorUserId.trim();
  if (actorUserId.length === 0 || actorUserId.length > 512) {
    throw new OperationsDetailServiceError(
      "validation_error",
      "运营明细管理员身份无效"
    );
  }
  const tokenSecret = resolveCursorSecret(dependencies.tokenSecret);
  return dependencies.repository.withReadOnlySnapshot(async (reader) => {
    const header = await reader.readHeader();
    if (!header.epoch) {
      throw new OperationsDetailServiceError(
        "not_ready",
        "运营统计起点尚未初始化"
      );
    }
    let asOf = header.asOf;
    let cursor: OperationsDetailCursor | null = null;
    if (parsed.cursor) {
      const decoded = decodeOperationsDetailCursor(
        parsed.cursor,
        {
          actorUserId,
          filters: parsed,
          asOfNotAfter: header.asOf,
        },
        tokenSecret
      );
      asOf = decoded.asOf;
      cursor = decoded.sortKey;
    }
    let range: ReturnType<typeof resolveOperationsDashboardRange>;
    try {
      range = resolveOperationsDashboardRange(
        { granularity: parsed.granularity, range: parsed.range },
        {
          timeZone: request.timeZone,
          asOf,
          epochDate: header.epoch.appDate,
        }
      );
    } catch (error) {
      if (error instanceof RangeError) {
        throw new OperationsDetailServiceError(
          "validation_error",
          "运营明细日期范围无效"
        );
      }
      throw error;
    }
    const rows = range.dataStart
      ? await reader.readRows(
          buildDetailQuery({
            parsed,
            start: range.dataStart,
            end: range.end,
            epochStart: header.epoch.startsAt,
            asOf,
            timeZone: request.timeZone,
            cursor,
          })
        )
      : [];
    const queryStart =
      parsed.selection.detail === "retention_cohorts"
        ? requireAppDateStart(parsed.selection.cohortDate, request.timeZone)
        : range.dataStart;
    const queryEnd =
      parsed.selection.detail === "retention_cohorts"
        ? requireAppDateStart(
            addOperationsCalendarDays(parsed.selection.cohortDate, 1),
            request.timeZone
          )
        : range.end;
    for (const row of rows) {
      if (
        Number.isNaN(row.businessTime.getTime()) ||
        row.businessTime > asOf ||
        row.businessTime < (queryStart ?? queryEnd) ||
        row.businessTime >= queryEnd
      ) {
        throw new OperationsDetailServiceError(
          "invalid_data",
          "运营明细数据库结果超出查询范围"
        );
      }
      if (row.kind === "content" && row.operationCreatedAtMismatch) {
        throw new OperationsDetailServiceError(
          "invalid_data",
          "成功产物与积分操作业务时间不一致"
        );
      }
    }
    const page = paginateOperationsDetailRows(rows, parsed.limit);
    return {
      selection: parsed.selection,
      range,
      rows: page.rows.map(adaptDetailRow),
      nextCursor: page.nextCursor
        ? encodeOperationsDetailCursor(
            {
              actorUserId,
              filters: parsed,
              asOf,
              sortKey: page.nextCursor,
            },
            tokenSecret
          )
        : null,
    };
  });
}
