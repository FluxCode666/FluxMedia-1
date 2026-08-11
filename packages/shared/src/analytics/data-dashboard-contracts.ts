/**
 * 用户数据看板的唯一 strict 输入输出契约。
 *
 * UOL operation、聚合服务、Web 页面与站内 Agent 必须复用这里的 schema，避免身份、
 * 日期、单位或跨字段口径漂移。本模块只依赖 Zod 与 DB-free 时区工具，不读取运行时
 * 设置或数据库。管理员用户筛选使用本文件中的专用输入/输出契约。
 */
import { z } from "zod";

import {
  formatDateInputInTimeZone,
  isValidTimeZone,
  parseDateInputInTimeZone,
} from "../time-zone";

/** 数据看板默认包含今天在内的自然日数量，供 resolver 与 Web 选择器共享。 */
export const DATA_DASHBOARD_DEFAULT_DAYS = 7;
/** 数据看板允许的最大 inclusive 自然日与逐日桶数量。 */
export const DATA_DASHBOARD_MAX_DAYS = 30;
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const CREDITS_EPSILON = 1e-9;

const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_SAFE_COUNT);
const nonnegativeCreditsSchema = z.number().finite().nonnegative();
const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * 判断固定格式字符串是否为可 round-trip 的 Gregorian 日期。
 *
 * @param value 待校验的 YYYY-MM-DD 字符串。
 * @returns 日期真实存在时返回 true；无副作用。
 */
function isValidGregorianDate(value: string): boolean {
  return parseDateInputInTimeZone(value, { timeZone: "UTC" }) !== null;
}

const gregorianDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "必须使用 YYYY-MM-DD 格式")
  .refine(isValidGregorianDate, "日期必须是有效的 Gregorian 日期");

const dataDashboardCustomInputSchema = z
  .object({
    startDate: gregorianDateSchema,
    endDate: gregorianDateSchema,
  })
  .strict();

const dataDashboardDefaultInputSchema = z.object({}).strict();

export const dataDashboardInputSchema = z.union([
  dataDashboardCustomInputSchema,
  dataDashboardDefaultInputSchema,
]);

const adminDataDashboardUserIdSchema = z.string().trim().min(1).max(512);

const adminDataDashboardCustomInputSchema = z
  .object({
    startDate: gregorianDateSchema,
    endDate: gregorianDateSchema,
    userId: adminDataDashboardUserIdSchema.optional(),
  })
  .strict();

const adminDataDashboardDefaultInputSchema = z
  .object({ userId: adminDataDashboardUserIdSchema.optional() })
  .strict();

/** 管理员专用日期范围输入；用户 ID 由下拉搜索结果提供，不接受邮箱或名称。 */
export const adminDataDashboardInputSchema = z.union([
  adminDataDashboardCustomInputSchema,
  adminDataDashboardDefaultInputSchema,
]);

/** 管理员用户下拉搜索输入；query 同时匹配名称与邮箱。 */
export const adminDataDashboardUserSearchInputSchema = z
  .object({
    query: z.string().trim().max(160).default(""),
    limit: z.number().int().min(1).max(50).default(20),
    selectedUserId: adminDataDashboardUserIdSchema.optional(),
  })
  .strict();

export const adminDataDashboardUserOptionSchema = z
  .object({
    id: adminDataDashboardUserIdSchema,
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().email().max(320),
  })
  .strict();

export const adminDataDashboardUserSearchOutputSchema = z
  .object({
    users: z.array(adminDataDashboardUserOptionSchema).max(50),
  })
  .strict();

const dataDashboardRangeSchema = z
  .object({
    startDate: gregorianDateSchema,
    endDate: gregorianDateSchema,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
  })
  .strict();

const dataDashboardSuccessRateSchema = z
  .object({
    succeeded: nonnegativeSafeIntegerSchema,
    failed: nonnegativeSafeIntegerSchema,
    terminal: nonnegativeSafeIntegerSchema,
    rate: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

const dataDashboardMostUsedModelSchema = z
  .object({
    model: z.string().trim().min(1).max(255),
    taskCount: nonnegativeSafeIntegerSchema.positive(),
  })
  .strict();

const dataDashboardMetricsSchema = z
  .object({
    imageCount: nonnegativeSafeIntegerSchema,
    videoSeconds: nonnegativeSafeIntegerSchema,
    creditsConsumed: nonnegativeCreditsSchema,
    successRate: dataDashboardSuccessRateSchema,
    activeDays: nonnegativeSafeIntegerSchema.max(DATA_DASHBOARD_MAX_DAYS),
    mostUsedModel: dataDashboardMostUsedModelSchema.nullable(),
  })
  .strict();

export const dataDashboardBucketSchema = z
  .object({
    date: gregorianDateSchema,
    start: isoDateTimeSchema,
    end: isoDateTimeSchema,
    imageCount: nonnegativeSafeIntegerSchema,
    imageTaskCount: nonnegativeSafeIntegerSchema,
    videoCount: nonnegativeSafeIntegerSchema,
    videoSeconds: nonnegativeSafeIntegerSchema,
    creditsConsumed: nonnegativeCreditsSchema,
  })
  .strict();

const dataDashboardTaskCompositionSchema = z
  .object({
    imageTaskCount: nonnegativeSafeIntegerSchema,
    videoCount: nonnegativeSafeIntegerSchema,
    totalTasks: nonnegativeSafeIntegerSchema,
  })
  .strict();

const dataDashboardOutputBaseSchema = z
  .object({
    asOf: isoDateTimeSchema,
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, "必须是有效的 IANA 时区"),
    today: gregorianDateSchema,
    range: dataDashboardRangeSchema,
    metrics: dataDashboardMetricsSchema,
    buckets: z
      .array(dataDashboardBucketSchema)
      .min(1)
      .max(DATA_DASHBOARD_MAX_DAYS),
    taskComposition: dataDashboardTaskCompositionSchema,
  })
  .strict();

type DataDashboardOutputBase = z.infer<typeof dataDashboardOutputBaseSchema>;

/**
 * 将合法 Gregorian 日期移动指定自然日数。
 *
 * @param value 已通过 schema 的 YYYY-MM-DD 日期。
 * @param days 可正可负的整数自然日数。
 * @returns 移动后的固定格式日期；无时区或 I/O 副作用。
 */
function shiftGregorianDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0));
  date.setUTCDate(date.getUTCDate() + days);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 计算两个合法 Gregorian 日期首尾包含的自然日数量。
 *
 * @param startDate 起始日期。
 * @param endDate 结束日期。
 * @returns 正向范围的 inclusive 天数；反向范围返回非正数。
 */
function countInclusiveDates(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

/**
 * 比较积分合计，容纳数据库 decimal 转为 JavaScript number 后的最小舍入误差。
 *
 * @param left 第一项有限非负积分。
 * @param right 第二项有限非负积分。
 * @returns 误差不超过相对或绝对阈值时返回 true。
 */
function creditsEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= CREDITS_EPSILON * scale;
}

/**
 * 添加一个定位明确的自定义 Zod issue。
 *
 * @param context 当前 schema 的 refinement 上下文。
 * @param path 错误字段路径。
 * @param message 面向调用方的稳定错误说明。
 * @returns 无返回值；副作用仅限收集当前解析错误。
 */
function addIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string
): void {
  context.addIssue({ code: "custom", path, message });
}

/**
 * 校验输出范围、自然日桶、六项指标、任务构成和成功率的跨字段 invariant。
 *
 * @param output 已通过逐字段校验的看板快照。
 * @param context Zod refinement 上下文。
 * @returns 无返回值；发现漂移时累计所有可定位问题，不修改输入。
 */
function validateDataDashboardOutput(
  output: DataDashboardOutputBase,
  context: z.RefinementCtx
): void {
  const inclusiveDays = countInclusiveDates(
    output.range.startDate,
    output.range.endDate
  );
  if (inclusiveDays <= 0 || inclusiveDays > DATA_DASHBOARD_MAX_DAYS) {
    addIssue(context, ["range", "endDate"], "日期范围必须为 1 至 30 天");
  }
  if (inclusiveDays !== output.buckets.length) {
    addIssue(context, ["buckets"], "日桶数量必须等于日期范围自然日数量");
  }
  if (output.range.endDate > output.today) {
    addIssue(context, ["range", "endDate"], "日期范围不能处于未来");
  }

  const asOfMs = Date.parse(output.asOf);
  const rangeStartMs = Date.parse(output.range.start);
  const rangeEndMs = Date.parse(output.range.end);
  const expectedToday = formatDateInputInTimeZone(
    new Date(asOfMs),
    output.timeZone
  );
  if (output.today !== expectedToday) {
    addIssue(context, ["today"], "today 必须匹配 asOf 在账号时区中的日期");
  }
  if (rangeEndMs > asOfMs) {
    addIssue(context, ["range", "end"], "UTC 范围结束不能晚于 asOf");
  }

  let imageCount = 0;
  let imageTaskCount = 0;
  let videoCount = 0;
  let videoSeconds = 0;
  let creditsConsumed = 0;
  let activeDays = 0;

  for (const [index, bucket] of output.buckets.entries()) {
    const expectedDate = shiftGregorianDate(output.range.startDate, index);
    if (bucket.date !== expectedDate) {
      addIssue(context, ["buckets", index, "date"], "日桶日期必须连续");
    }
    if (index === 0 && bucket.date !== output.range.startDate) {
      addIssue(context, ["buckets", index, "date"], "首桶日期必须匹配范围");
    }
    if (
      index === output.buckets.length - 1 &&
      bucket.date !== output.range.endDate
    ) {
      addIssue(context, ["buckets", index, "date"], "末桶日期必须匹配范围");
    }

    const bucketStartMs = Date.parse(bucket.start);
    const bucketEndMs = Date.parse(bucket.end);
    if (bucketEndMs < bucketStartMs) {
      addIssue(context, ["buckets", index, "end"], "日桶结束不能早于开始");
    }
    const expectedStart = parseDateInputInTimeZone(bucket.date, {
      timeZone: output.timeZone,
    });
    const naturalEnd = parseDateInputInTimeZone(
      shiftGregorianDate(bucket.date, 1),
      { timeZone: output.timeZone }
    );
    if (!expectedStart || bucketStartMs !== expectedStart.getTime()) {
      addIssue(
        context,
        ["buckets", index, "start"],
        "日桶开始必须是账号时区零点"
      );
    }
    const expectedEndMs =
      bucket.date === output.today ? asOfMs : naturalEnd?.getTime();
    if (expectedEndMs === undefined || bucketEndMs !== expectedEndMs) {
      addIssue(
        context,
        ["buckets", index, "end"],
        "日桶结束必须是次日零点或同一 asOf"
      );
    }

    const previous = output.buckets[index - 1];
    if (previous && Date.parse(previous.end) !== bucketStartMs) {
      addIssue(
        context,
        ["buckets", index, "start"],
        "相邻日桶必须连续且不重叠"
      );
    }
    if (bucket.imageTaskCount > bucket.imageCount) {
      addIssue(
        context,
        ["buckets", index, "imageTaskCount"],
        "图片任务数不能超过图片产物数"
      );
    }

    imageCount += bucket.imageCount;
    imageTaskCount += bucket.imageTaskCount;
    videoCount += bucket.videoCount;
    videoSeconds += bucket.videoSeconds;
    creditsConsumed += bucket.creditsConsumed;
    if (bucket.imageTaskCount > 0 || bucket.videoCount > 0) activeDays += 1;
  }

  if (
    Date.parse(output.buckets[0]?.start ?? "") !== rangeStartMs ||
    rangeStartMs > rangeEndMs
  ) {
    addIssue(context, ["range", "start"], "UTC 范围必须匹配首桶且保持正向");
  }
  if (Date.parse(output.buckets.at(-1)?.end ?? "") !== rangeEndMs) {
    addIssue(context, ["range", "end"], "UTC 范围必须匹配末桶");
  }
  if (output.range.endDate === output.today && rangeEndMs !== asOfMs) {
    addIssue(context, ["range", "end"], "包含今天的范围必须截止同一 asOf");
  }

  if (imageCount !== output.metrics.imageCount) {
    addIssue(context, ["metrics", "imageCount"], "图片总数必须等于日桶合计");
  }
  if (videoSeconds !== output.metrics.videoSeconds) {
    addIssue(context, ["metrics", "videoSeconds"], "视频秒数必须等于日桶合计");
  }
  if (!creditsEqual(creditsConsumed, output.metrics.creditsConsumed)) {
    addIssue(
      context,
      ["metrics", "creditsConsumed"],
      "积分消耗必须等于日桶合计"
    );
  }
  if (activeDays !== output.metrics.activeDays) {
    addIssue(
      context,
      ["metrics", "activeDays"],
      "活跃天数必须由成功任务日桶派生"
    );
  }

  const composition = output.taskComposition;
  if (composition.imageTaskCount !== imageTaskCount) {
    addIssue(
      context,
      ["taskComposition", "imageTaskCount"],
      "图片任务构成必须使用 imageTaskCount"
    );
  }
  if (composition.videoCount !== videoCount) {
    addIssue(
      context,
      ["taskComposition", "videoCount"],
      "视频任务构成必须使用 videoCount"
    );
  }
  if (composition.totalTasks !== imageTaskCount + videoCount) {
    addIssue(
      context,
      ["taskComposition", "totalTasks"],
      "成功任务总数必须等于图片与视频任务构成"
    );
  }

  const successRate = output.metrics.successRate;
  if (successRate.succeeded !== composition.totalTasks) {
    addIssue(
      context,
      ["metrics", "successRate", "succeeded"],
      "成功任务数必须等于任务构成总数"
    );
  }
  if (successRate.terminal !== successRate.succeeded + successRate.failed) {
    addIssue(
      context,
      ["metrics", "successRate", "terminal"],
      "终态任务数必须等于成功与失败任务数之和"
    );
  }
  if (successRate.terminal === 0) {
    if (successRate.rate !== null) {
      addIssue(
        context,
        ["metrics", "successRate", "rate"],
        "无终态任务时成功率必须为 null"
      );
    }
  } else {
    const expectedRate = successRate.succeeded / successRate.terminal;
    if (
      successRate.rate === null ||
      Math.abs(successRate.rate - expectedRate) > Number.EPSILON * 8
    ) {
      addIssue(
        context,
        ["metrics", "successRate", "rate"],
        "成功率必须等于成功任务数除以终态任务数"
      );
    }
  }

  const mostUsedModel = output.metrics.mostUsedModel;
  if (successRate.succeeded === 0 && mostUsedModel !== null) {
    addIssue(
      context,
      ["metrics", "mostUsedModel"],
      "无成功任务时常用模型必须为 null"
    );
  }
  if (successRate.succeeded > 0 && mostUsedModel === null) {
    addIssue(
      context,
      ["metrics", "mostUsedModel"],
      "有成功任务时必须返回稳定的常用模型"
    );
  }
  if (mostUsedModel && mostUsedModel.taskCount > successRate.succeeded) {
    addIssue(
      context,
      ["metrics", "mostUsedModel", "taskCount"],
      "常用模型任务数不能超过成功任务数"
    );
  }
}

export const dataDashboardOutputSchema =
  dataDashboardOutputBaseSchema.superRefine(validateDataDashboardOutput);

export type DataDashboardInput = z.infer<typeof dataDashboardInputSchema>;
export type AdminDataDashboardInput = z.infer<
  typeof adminDataDashboardInputSchema
>;
export type AdminDataDashboardUserSearchInput = z.infer<
  typeof adminDataDashboardUserSearchInputSchema
>;
export type AdminDataDashboardUserOption = z.infer<
  typeof adminDataDashboardUserOptionSchema
>;
export type AdminDataDashboardUserSearchOutput = z.infer<
  typeof adminDataDashboardUserSearchOutputSchema
>;
export type DataDashboardBucket = z.infer<typeof dataDashboardBucketSchema>;
export type DataDashboardOutput = z.infer<typeof dataDashboardOutputSchema>;
