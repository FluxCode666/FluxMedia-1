/**
 * Pino 日志时间戳的展示时区适配器。
 *
 * 使用方是共享日志模块。标准 `time` 字段继续保留 UTC，供日志平台排序和跨服务关联；
 * `localTime` 按 APP_TIME_ZONE 输出带偏移的 ISO 8601 时间，供运维直接阅读。
 */
import { DEFAULT_APP_TIME_ZONE, normalizeTimeZone } from "../time-zone";

type LogClock = () => Date;

/**
 * 从 Intl 分段结果中读取指定字段。
 *
 * @param parts Intl 生成的日期时间分段。
 * @param type 需要读取的分段类型。
 * @returns 对应字段值；运行时缺少字段时抛错，避免输出不可解析的时间戳。
 */
function requirePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new RangeError(`日志时间戳缺少 ${type} 字段`);
  }
  return value;
}

/**
 * 创建指定展示时区的 ISO 8601 日志时间格式化器。
 *
 * @param configuredTimeZone APP_TIME_ZONE 值；非法或缺失时回退 UTC。
 * @returns 可重复使用的格式化函数；输入无效 Date 时抛出 RangeError，无外部副作用。
 */
export function createLogTimestampFormatter(
  configuredTimeZone?: string | null
): (date: Date) => string {
  const timeZone = normalizeTimeZone(configuredTimeZone, DEFAULT_APP_TIME_ZONE);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    timeZoneName: "longOffset",
    hourCycle: "h23",
  });

  return (date) => {
    const parts = formatter.formatToParts(date);
    const offset = requirePart(parts, "timeZoneName").replace(/^GMT/, "");
    const suffix = offset === "+00:00" || offset === "-00:00" ? "Z" : offset;
    return `${requirePart(parts, "year")}-${requirePart(
      parts,
      "month"
    )}-${requirePart(parts, "day")}T${requirePart(
      parts,
      "hour"
    )}:${requirePart(parts, "minute")}:${requirePart(
      parts,
      "second"
    )}.${requirePart(parts, "fractionalSecond")}${suffix}`;
  };
}

/**
 * 创建 Pino timestamp 钩子，同时写入标准 UTC 与运维展示时间。
 *
 * @param configuredTimeZone APP_TIME_ZONE 值；非法或缺失时回退 UTC。
 * @param clock 当前时间来源；测试可注入固定时钟，生产默认读取系统时钟。
 * @returns Pino 所需的 JSON 字段片段；每次调用读取一次时钟，无其他副作用。
 */
export function createPinoTimestamp(
  configuredTimeZone?: string | null,
  clock: LogClock = () => new Date()
): () => string {
  const timeZone = normalizeTimeZone(configuredTimeZone, DEFAULT_APP_TIME_ZONE);
  const formatLocalTime = createLogTimestampFormatter(timeZone);

  return () => {
    const date = clock();
    return `,"time":${JSON.stringify(
      date.toISOString()
    )},"localTime":${JSON.stringify(
      formatLocalTime(date)
    )},"timeZone":${JSON.stringify(timeZone)}`;
  };
}
