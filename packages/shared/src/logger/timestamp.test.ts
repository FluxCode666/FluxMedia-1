/**
 * 日志时间戳格式化器的 DB-free 回归测试。
 *
 * 使用方是 Pino 日志模块；确保 APP_TIME_ZONE 只改变日志展示时间，不依赖进程 TZ，
 * 同时保留 ISO 8601 偏移以便日志平台还原同一个 UTC 瞬间。
 */
import { describe, expect, it } from "vitest";

import { createLogTimestampFormatter, createPinoTimestamp } from "./timestamp";

describe("createLogTimestampFormatter", () => {
  it("formats logs in the configured Asia/Shanghai time zone", () => {
    const formatTimestamp = createLogTimestampFormatter("Asia/Shanghai");

    expect(formatTimestamp(new Date("2026-08-03T06:25:11.232Z"))).toBe(
      "2026-08-03T14:25:11.232+08:00"
    );
  });

  it("uses the daylight-saving offset at the logged instant", () => {
    const formatTimestamp = createLogTimestampFormatter("America/New_York");

    expect(formatTimestamp(new Date("2026-01-15T12:00:00.000Z"))).toBe(
      "2026-01-15T07:00:00.000-05:00"
    );
    expect(formatTimestamp(new Date("2026-07-15T12:00:00.000Z"))).toBe(
      "2026-07-15T08:00:00.000-04:00"
    );
  });

  it("falls back to UTC when APP_TIME_ZONE is invalid", () => {
    const formatTimestamp = createLogTimestampFormatter("not-a-time-zone");

    expect(formatTimestamp(new Date("2026-08-03T06:25:11.232Z"))).toBe(
      "2026-08-03T06:25:11.232Z"
    );
  });

  it("keeps UTC time and adds a local operator-facing timestamp", () => {
    const timestamp = createPinoTimestamp(
      "Asia/Shanghai",
      () => new Date("2026-08-03T06:25:11.232Z")
    );

    expect(JSON.parse(`{${timestamp().slice(1)}}`)).toEqual({
      time: "2026-08-03T06:25:11.232Z",
      localTime: "2026-08-03T14:25:11.232+08:00",
      timeZone: "Asia/Shanghai",
    });
  });
});
