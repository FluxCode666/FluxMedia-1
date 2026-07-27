/**
 * 管理端全局生成历史的 DB-free 应用服务。
 *
 * 使用方：管理员历史 UOL binding。职责是校验管理员可见的筛选、按管理员时区解析
 * 日期、验证筛选绑定的 HMAC cursor，并将仓储窄行收敛为包含用户邮箱和 ID 的安全输出。
 * 此服务与个人历史服务分离，防止全局查询作用域或 cursor 误复用到普通用户入口。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type AdminHistoryListOutput,
  type AdminHistoryRecord,
  adminHistoryCursorFiltersSchema,
  adminHistoryListInputSchema,
  adminHistoryListOutputSchema,
  adminHistoryRecordSchema,
  type HistoryCreditDetails,
  type HistoryRecordStatus,
  type HistoryReferenceImage,
} from "@repo/shared/image-generation/history-contract";
import { z } from "zod";

import {
  resolveHistoryDateRange,
  sanitizeHistoryError,
} from "./history-service";

const ADMIN_HISTORY_CURSOR_VERSION = 1;
const ADMIN_HISTORY_CURSOR_DOMAIN =
  "fluxmedia:admin-generation-history:cursor:v1";
const ADMIN_HISTORY_FILTER_DOMAIN =
  "fluxmedia:admin-generation-history:filters:v1";
const MAX_CURSOR_LENGTH = 4096;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HISTORY_KIND_RANK = { image: 1, video: 0 } as const;

const adminHistoryCursorPayloadSchema = z
  .object({
    v: z.literal(ADMIN_HISTORY_CURSOR_VERSION),
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

/** 仓储主查询使用的稳定输入；不接受调用方传入的管理员身份。 */
export interface AdminHistoryListQuery {
  start: Date | null;
  end: Date | null;
  asOf: Date;
  model: string | null;
  status: HistoryRecordStatus | null;
  type: "image" | "video" | null;
  userEmail: string | null;
  cursor: {
    createdAt: Date;
    kindRank: number;
    id: string;
    direction: "next" | "previous";
  } | null;
  branchLimit: number;
}

interface AdminHistoryRowCommon {
  id: string;
  userId: string;
  userEmail: string;
  prompt: string;
  model: string;
  status: HistoryRecordStatus;
  creditsConsumed: number;
  rawError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

/** PostgreSQL 仓储返回的管理端图片窄行。 */
export interface AdminImageHistoryRow extends AdminHistoryRowCommon {
  kind: "image";
  revisedPrompt: string | null;
  size: string;
  creditDetails: HistoryCreditDetails | null;
  promptRepairNotice: string | null;
  referenceImages: HistoryReferenceImage[];
  imageUrl: string | null;
}

/** PostgreSQL 仓储返回的管理端视频窄行。 */
export interface AdminVideoHistoryRow extends AdminHistoryRowCommon {
  kind: "video";
  family: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio: string;
  videoUrl: string | null;
}

export type AdminHistoryListRow = AdminImageHistoryRow | AdminVideoHistoryRow;

/** 管理端仓储端口；查询始终是全局作用域，邮箱仅是精确筛选条件。 */
export interface AdminHistoryRepository {
  readRecords(query: AdminHistoryListQuery): Promise<AdminHistoryListRow[]>;
  readModelOptions(input: {
    userEmail: string | null;
    type: "image" | "video" | null;
    limit: number;
  }): Promise<string[]>;
  readUserOptions(input: {
    type: "image" | "video" | null;
    limit: number;
  }): Promise<Array<{ id: string; email: string }>>;
}

/** 管理端列表的稳定校验错误，不泄漏 cursor、管理员 ID 或内部 SQL。 */
export class AdminHistoryServiceError extends Error {
  readonly code = "validation_error" as const;

  /** 创建可安全映射到 UOL 的固定校验错误。 */
  constructor(message = "Invalid admin history query") {
    super(message);
    this.name = "AdminHistoryServiceError";
  }
}

/** 把 Date/string 严格转换为带时区 ISO；仓储脏数据必须显式失败。 */
function toIsoDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Admin history record date is invalid");
  }
  return date.toISOString();
}

/** 获取测试注入或生产认证密钥；缺失配置时不得签发不安全 cursor。 */
function resolveCursorSecret(secret?: string): string {
  const value = secret ?? process.env.BETTER_AUTH_SECRET;
  if (!value?.trim()) {
    throw new Error("BETTER_AUTH_SECRET is required for admin history cursors");
  }
  return value;
}

/** 对管理员历史的规范化筛选做固定长度 HMAC 指纹。 */
function fingerprintFilters(
  filters: z.output<typeof adminHistoryCursorFiltersSchema>,
  secret: string
): string {
  const parsed = adminHistoryCursorFiltersSchema.parse(filters);
  return createHmac("sha256", secret)
    .update(ADMIN_HISTORY_FILTER_DOMAIN)
    .update("\0")
    .update(JSON.stringify(parsed))
    .digest("base64url");
}

/** 使用独立域标签签名管理端 cursor，禁止与个人历史 token 互换。 */
function signCursorPayload(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(ADMIN_HISTORY_CURSOR_DOMAIN)
    .update("\0")
    .update(payload)
    .digest();
}

/** 签发绑定管理员、筛选、快照和完整排序键的全局历史 cursor。 */
function encodeAdminHistoryCursor(
  input: {
    actorUserId: string;
    filters: z.output<typeof adminHistoryCursorFiltersSchema>;
    asOf: string;
    direction: "next" | "previous";
    sortKey: { createdAt: string; kindRank: number; id: string };
  },
  secret?: string
): string {
  const resolvedSecret = resolveCursorSecret(secret);
  const payload = adminHistoryCursorPayloadSchema.parse({
    v: ADMIN_HISTORY_CURSOR_VERSION,
    sub: input.actorUserId,
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

/** 验证管理端 cursor 的格式、HMAC、管理员、筛选指纹与快照上限。 */
function decodeAdminHistoryCursor(
  token: string,
  expected: {
    actorUserId: string;
    filters: z.output<typeof adminHistoryCursorFiltersSchema>;
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
      throw new AdminHistoryServiceError();
    }
    const [payloadPart, signaturePart, extraPart] = token.split(".");
    if (
      !payloadPart ||
      !signaturePart ||
      extraPart !== undefined ||
      !BASE64URL_PATTERN.test(payloadPart) ||
      !BASE64URL_PATTERN.test(signaturePart)
    ) {
      throw new AdminHistoryServiceError();
    }
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    const signatureBytes = Buffer.from(signaturePart, "base64url");
    if (
      payloadBytes.toString("base64url") !== payloadPart ||
      signatureBytes.toString("base64url") !== signaturePart
    ) {
      throw new AdminHistoryServiceError();
    }
    const resolvedSecret = resolveCursorSecret(secret);
    const expectedSignature = signCursorPayload(payloadPart, resolvedSecret);
    if (
      signatureBytes.length !== expectedSignature.length ||
      !timingSafeEqual(signatureBytes, expectedSignature)
    ) {
      throw new AdminHistoryServiceError();
    }
    const payload = adminHistoryCursorPayloadSchema.parse(
      JSON.parse(payloadBytes.toString("utf8")) as unknown
    );
    const expectedFilter = fingerprintFilters(expected.filters, resolvedSecret);
    const left = Buffer.from(payload.filter);
    const right = Buffer.from(expectedFilter);
    const asOf = new Date(payload.asOf);
    const createdAt = new Date(payload.sortKey.createdAt);
    if (
      payload.sub !== expected.actorUserId ||
      left.length !== right.length ||
      !timingSafeEqual(left, right) ||
      asOf > expected.asOfNotAfter ||
      createdAt > asOf
    ) {
      throw new AdminHistoryServiceError();
    }
    return {
      asOf,
      direction: payload.direction,
      sortKey: { ...payload.sortKey, createdAt },
    };
  } catch (error) {
    if (error instanceof AdminHistoryServiceError) throw error;
    throw new AdminHistoryServiceError();
  }
}

/** 将全局仓储窄行收敛为可安全跨 UOL 的管理员历史记录。 */
function adaptAdminHistoryRow(row: AdminHistoryListRow): AdminHistoryRecord {
  const { rawError, ...safeRow } = row;
  return adminHistoryRecordSchema.parse({
    ...safeRow,
    error: sanitizeHistoryError(rawError),
    createdAt: toIsoDateTime(row.createdAt),
    completedAt: row.completedAt ? toIsoDateTime(row.completedAt) : null,
  });
}

/**
 * 读取管理员可见的一页全局生成历史与筛选选项。
 *
 * @param request 已验证管理员身份、管理员时区与不可信输入。
 * @param dependencies DB-free 仓储和可选测试密钥。
 * @returns 受管理员 cursor 约束的全局记录、模型选项和用户邮箱选项。
 */
export async function loadAdminHistoryRecords(
  request: {
    actorUserId: string;
    timeZone: string;
    input: unknown;
    now?: Date;
  },
  dependencies: { repository: AdminHistoryRepository; tokenSecret?: string }
): Promise<AdminHistoryListOutput> {
  const parsed = adminHistoryListInputSchema.parse(request.input);
  const filters = adminHistoryCursorFiltersSchema.parse({
    createdFrom: parsed.createdFrom,
    createdTo: parsed.createdTo,
    model: parsed.model,
    status: parsed.status,
    type: parsed.type,
    userEmail: parsed.userEmail,
  });
  const range = resolveHistoryDateRange({
    createdFrom: parsed.createdFrom,
    createdTo: parsed.createdTo,
    timeZone: request.timeZone,
  });
  const serverNow = request.now ?? new Date();
  let asOf = serverNow;
  let cursor: AdminHistoryListQuery["cursor"] = null;
  if (parsed.cursor) {
    const decoded = decodeAdminHistoryCursor(
      parsed.cursor,
      {
        actorUserId: request.actorUserId,
        filters,
        asOfNotAfter: serverNow,
      },
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
    throw new AdminHistoryServiceError();
  }

  const [rows, rawModelOptions, rawUserOptions] = await Promise.all([
    dependencies.repository.readRecords({
      start: range.start,
      end: range.end,
      asOf,
      model: parsed.model,
      status: parsed.status,
      type: parsed.type,
      userEmail: parsed.userEmail,
      cursor,
      branchLimit: parsed.limit + 1,
    }),
    dependencies.repository.readModelOptions({
      userEmail: parsed.userEmail,
      type: parsed.type,
      limit: 200,
    }),
    dependencies.repository.readUserOptions({ type: parsed.type, limit: 200 }),
  ]);
  const direction = cursor?.direction ?? "next";
  const hasExtra = rows.length > parsed.limit;
  const selectedRows = rows.slice(0, parsed.limit);
  const pageRows =
    direction === "previous" ? selectedRows.reverse() : selectedRows;
  const records = pageRows.map(adaptAdminHistoryRow);
  const first = pageRows[0] ?? null;
  const last = pageRows.at(-1) ?? null;
  const canReadNext = direction === "previous" ? Boolean(cursor) : hasExtra;
  const canReadPrevious = direction === "previous" ? hasExtra : Boolean(cursor);
  const createCursor = (
    row: AdminHistoryListRow,
    cursorDirection: "next" | "previous"
  ) =>
    encodeAdminHistoryCursor(
      {
        actorUserId: request.actorUserId,
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
  const userOptions = Array.from(
    new Map(
      rawUserOptions.map((option) => [
        option.id,
        { id: option.id, email: option.email.trim() },
      ])
    ).values()
  )
    .filter((option) => option.id && option.email)
    .sort((left, right) => left.email.localeCompare(right.email))
    .slice(0, 200);

  return adminHistoryListOutputSchema.parse({
    asOf: asOf.toISOString(),
    records,
    modelOptions,
    userOptions,
    nextCursor,
    previousCursor,
  });
}
