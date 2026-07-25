/**
 * 统一生成历史的 DB-free 应用服务。
 *
 * 使用方：UOL binding。职责是校验筛选、按用户时区解析包含结束日的范围、验证主体与
 * 筛选绑定的 HMAC cursor，并把仓储窄行收敛为共享 image/video 判别联合。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type HistoryCreditDetails,
  type HistoryCursorFilters,
  type HistoryListOutput,
  type HistoryRecord,
  type HistoryRecordStatus,
  type HistoryReferenceImage,
  historyCursorFiltersSchema,
  historyListInputSchema,
  historyListOutputSchema,
  historyRecordSchema,
} from "@repo/shared/image-generation/history-contract";
import { parseDateInputInTimeZone } from "@repo/shared/time-zone";
import { z } from "zod";

const HISTORY_CURSOR_VERSION = 1;
const HISTORY_CURSOR_DOMAIN = "fluxmedia:generation-history:cursor:v1";
const HISTORY_FILTER_DOMAIN = "fluxmedia:generation-history:filters:v1";
const MAX_CURSOR_LENGTH = 4096;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HISTORY_KIND_RANK = { image: 1, video: 0 } as const;

const historyCursorPayloadSchema = z
  .object({
    v: z.literal(HISTORY_CURSOR_VERSION),
    sub: z.string().min(1).max(512),
    filter: z.string().length(43),
    direction: z.enum(["next", "previous"]),
    asOf: z.string().datetime({ offset: true }),
    sortKey: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        kindRank: z.number().int().min(0).max(1),
        id: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

/** 仓储主查询使用的稳定输入，所有身份和时间边界均由服务端生成。 */
export interface HistoryListQuery {
  userId: string;
  start: Date | null;
  end: Date | null;
  asOf: Date;
  model: string | null;
  status: HistoryRecordStatus | null;
  type: "image" | "video" | null;
  cursor: {
    createdAt: Date;
    kindRank: number;
    id: string;
    direction: "next" | "previous";
  } | null;
  branchLimit: number;
}

interface HistoryRowCommon {
  id: string;
  prompt: string;
  model: string;
  status: HistoryRecordStatus;
  creditsConsumed: number;
  rawError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

/** PostgreSQL 仓储返回的图片窄行。 */
export interface ImageHistoryRow extends HistoryRowCommon {
  kind: "image";
  revisedPrompt: string | null;
  size: string;
  creditDetails: HistoryCreditDetails | null;
  promptRepairNotice: string | null;
  referenceImages: HistoryReferenceImage[];
  imageUrl: string | null;
}

/** PostgreSQL 仓储返回的视频窄行。 */
export interface VideoHistoryRow extends HistoryRowCommon {
  kind: "video";
  family: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio: string;
  videoUrl: string | null;
}

export type HistoryListRow = ImageHistoryRow | VideoHistoryRow;

/** DB-free 仓储端口；主列表和真实模型选项都必须按本人查询且有界。 */
export interface HistoryRepository {
  readRecords(query: HistoryListQuery): Promise<HistoryListRow[]>;
  readModelOptions(input: {
    userId: string;
    type: "image" | "video" | null;
    limit: number;
  }): Promise<string[]>;
}

/** 查询层稳定错误，不包含 cursor、用户 ID 或内部 SQL。 */
export class HistoryServiceError extends Error {
  readonly code = "validation_error" as const;

  /** 创建固定、可安全映射到 UOL 的校验错误。 */
  constructor(message = "Invalid history query") {
    super(message);
    this.name = "HistoryServiceError";
  }
}

/** 把 Date/string 严格转换为带时区 ISO；仓储脏数据应显式失败。 */
function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("History record date is invalid");
  }
  return date.toISOString();
}

/** 将有效 YYYY-MM-DD 平移自然日，用于构造 createdTo 的下一日零点。 */
function shiftDateOnly(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return [
    shifted.getUTCFullYear().toString().padStart(4, "0"),
    (shifted.getUTCMonth() + 1).toString().padStart(2, "0"),
    shifted.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

/**
 * 按用户时区解析创建日期范围。
 *
 * @returns start 包含开始日零点；end 是结束日下一日零点，形成半开区间。
 */
export function resolveHistoryDateRange(input: {
  createdFrom: string | null;
  createdTo: string | null;
  timeZone: string;
}): { start: Date | null; end: Date | null } {
  const start = input.createdFrom
    ? parseDateInputInTimeZone(input.createdFrom, { timeZone: input.timeZone })
    : null;
  const end = input.createdTo
    ? parseDateInputInTimeZone(shiftDateOnly(input.createdTo, 1), {
        timeZone: input.timeZone,
      })
    : null;
  if ((input.createdFrom && !start) || (input.createdTo && !end)) {
    throw new HistoryServiceError();
  }
  if (start && end && start >= end) throw new HistoryServiceError();
  return { start, end };
}

/** 获取测试注入或生产认证密钥；缺失配置不能签发不安全 cursor。 */
function resolveCursorSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!value?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for history cursors");
  }
  return value;
}

/** 对规范化筛选做固定长度 HMAC 指纹。 */
function fingerprintFilters(
  filters: HistoryCursorFilters,
  secret: string
): string {
  const parsed = historyCursorFiltersSchema.parse(filters);
  return createHmac("sha256", secret)
    .update(HISTORY_FILTER_DOMAIN)
    .update("\0")
    .update(JSON.stringify(parsed))
    .digest("base64url");
}

/** 使用独立域标签签名 cursor payload，禁止与其他 token 互换。 */
function signCursorPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(HISTORY_CURSOR_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 签发主体、筛选、快照和完整排序键绑定的历史 cursor。 */
export function encodeHistoryCursor(
  input: {
    userId: string;
    filters: HistoryCursorFilters;
    asOf: string;
    direction: "next" | "previous";
    sortKey: { createdAt: string; kindRank: number; id: string };
  },
  secret?: string
): string {
  const resolvedSecret = resolveCursorSecret(secret);
  const payload = historyCursorPayloadSchema.parse({
    v: HISTORY_CURSOR_VERSION,
    sub: input.userId,
    filter: fingerprintFilters(input.filters, resolvedSecret),
    direction: input.direction,
    asOf: input.asOf,
    sortKey: input.sortKey,
  });
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  );
  const signature = signCursorPayload(encodedPayload, resolvedSecret).toString(
    "base64url"
  );
  return `${encodedPayload}.${signature}`;
}

/** 验证 cursor 格式、HMAC、主体、筛选指纹与快照上限。 */
function decodeHistoryCursor(
  token: string,
  expected: {
    userId: string;
    filters: HistoryCursorFilters;
    asOfNotAfter: Date;
  },
  secret?: string
): {
  asOf: Date;
  direction: "next" | "previous";
  sortKey: { createdAt: Date; kindRank: number; id: string };
} {
  try {
    if (!token || token.length > MAX_CURSOR_LENGTH) {
      throw new HistoryServiceError();
    }
    const [payloadPart, signaturePart, extraPart] = token.split(".");
    if (
      !payloadPart ||
      !signaturePart ||
      extraPart !== undefined ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new HistoryServiceError();
    }
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    const signatureBytes = Buffer.from(signaturePart, "base64url");
    if (
      payloadBytes.toString("base64url") !== payloadPart ||
      signatureBytes.toString("base64url") !== signaturePart
    ) {
      throw new HistoryServiceError();
    }
    const resolvedSecret = resolveCursorSecret(secret);
    const expectedSignature = signCursorPayload(payloadPart, resolvedSecret);
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new HistoryServiceError();
    }
    const payload = historyCursorPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    const expectedFilter = fingerprintFilters(expected.filters, resolvedSecret);
    const left = Buffer.from(payload.filter);
    const right = Buffer.from(expectedFilter);
    const asOf = new Date(payload.asOf);
    const createdAt = new Date(payload.sortKey.createdAt);
    if (
      payload.sub !== expected.userId ||
      left.length !== right.length ||
      !timingSafeEqual(left, right) ||
      asOf > expected.asOfNotAfter ||
      createdAt > asOf
    ) {
      throw new HistoryServiceError();
    }
    return {
      asOf,
      direction: payload.direction,
      sortKey: { ...payload.sortKey, createdAt },
    };
  } catch (error) {
    if (error instanceof HistoryServiceError) throw error;
    throw new HistoryServiceError();
  }
}

/** 将仓储窄行转换为共享判别联合，不把 Date 或 ORM 类型泄露到传输层。 */
function adaptHistoryRow(row: HistoryListRow): HistoryRecord {
  const { rawError, ...safeRow } = row;
  const common = {
    ...safeRow,
    error: sanitizeHistoryError(rawError),
    createdAt: toIsoDateTime(row.createdAt),
    completedAt: row.completedAt ? toIsoDateTime(row.completedAt) : null,
  };
  return historyRecordSchema.parse(common);
}

/** 将持久化原始失败收窄为简短稳定文案，禁止上游响应、SQL 或内部路径穿过 UOL。 */
export function sanitizeHistoryError(rawError: string | null): string | null {
  if (!rawError?.trim()) return null;
  const normalized = rawError.toLowerCase();
  if (/moderation|safety|content policy|审核|内容安全/.test(normalized)) {
    return "Content moderation blocked this generation";
  }
  if (/insufficient credits|积分不足/.test(normalized)) {
    return "Insufficient credits";
  }
  if (/timeout|timed out|deadline|超时/.test(normalized)) {
    return "Generation timed out";
  }
  if (/unavailable|overload|rate.?limit|无可用.*后端|限流/.test(normalized)) {
    return "Generation service is temporarily unavailable";
  }
  return "Generation failed";
}

/**
 * 读取当前主体的一页生成历史和真实模型选项。
 *
 * @param request 认证主体、用户时区与不可信输入。
 * @param dependencies DB-free 仓储和可选测试密钥。
 */
export async function loadHistoryRecords(
  request: {
    userId: string;
    timeZone: string;
    input: unknown;
    now?: Date;
  },
  dependencies: { repository: HistoryRepository; tokenSecret?: string }
): Promise<HistoryListOutput> {
  const parsed = historyListInputSchema.parse(request.input);
  const filters = historyCursorFiltersSchema.parse({
    createdFrom: parsed.createdFrom,
    createdTo: parsed.createdTo,
    model: parsed.model,
    status: parsed.status,
    type: parsed.type,
  });
  const range = resolveHistoryDateRange({
    createdFrom: parsed.createdFrom,
    createdTo: parsed.createdTo,
    timeZone: request.timeZone,
  });
  const serverNow = request.now ?? new Date();
  let asOf = serverNow;
  let cursor: HistoryListQuery["cursor"] = null;
  if (parsed.cursor) {
    const decoded = decodeHistoryCursor(
      parsed.cursor,
      { userId: request.userId, filters, asOfNotAfter: serverNow },
      dependencies.tokenSecret
    );
    asOf = decoded.asOf;
    cursor = { ...decoded.sortKey, direction: decoded.direction };
  }
  if (
    cursor &&
    ((range.start && cursor.createdAt < range.start) ||
      (range.end && cursor.createdAt >= range.end))
  ) {
    throw new HistoryServiceError();
  }

  const [rows, rawModelOptions] = await Promise.all([
    dependencies.repository.readRecords({
      userId: request.userId,
      start: range.start,
      end: range.end,
      asOf,
      model: parsed.model,
      status: parsed.status,
      type: parsed.type,
      cursor,
      branchLimit: parsed.limit + 1,
    }),
    dependencies.repository.readModelOptions({
      userId: request.userId,
      type: parsed.type,
      limit: 200,
    }),
  ]);
  const direction = cursor?.direction ?? "next";
  const hasExtra = rows.length > parsed.limit;
  const selectedRows = rows.slice(0, parsed.limit);
  const pageRows =
    direction === "previous" ? selectedRows.reverse() : selectedRows;
  const records = pageRows.map(adaptHistoryRow);
  const first = pageRows[0] ?? null;
  const last = pageRows.at(-1) ?? null;
  const canReadNext = direction === "previous" ? Boolean(cursor) : hasExtra;
  const canReadPrevious = direction === "previous" ? hasExtra : Boolean(cursor);
  const createCursor = (
    row: HistoryListRow,
    cursorDirection: "next" | "previous"
  ) =>
    encodeHistoryCursor(
      {
        userId: request.userId,
        filters,
        asOf: asOf.toISOString(),
        direction: cursorDirection,
        sortKey: {
          createdAt: toIsoDateTime(row.createdAt),
          kindRank: HISTORY_KIND_RANK[row.kind],
          id: row.id,
        },
      },
      dependencies.tokenSecret
    );
  const nextCursor = last && canReadNext ? createCursor(last, "next") : null;
  const previousCursor =
    first && canReadPrevious ? createCursor(first, "previous") : null;
  const modelOptions = Array.from(
    new Set(rawModelOptions.map((model) => model.trim()).filter(Boolean))
  )
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 200);

  return historyListOutputSchema.parse({
    asOf: asOf.toISOString(),
    records,
    modelOptions,
    nextCursor,
    previousCursor,
  });
}
