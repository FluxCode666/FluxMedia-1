/**
 * 视频 Redis MQ 重投时间策略单测。
 *
 * 使用方：Vitest；覆盖普通轮询、claim 防抢跑、提交观察窗口与终态停止。
 */

import { describe, expect, it } from "vitest";

import {
  resolveVideoQueueSchedule,
  VIDEO_SUBMISSION_RECOVERY_GRACE_MS,
  type VideoQueueScheduleRow,
} from "./video-queue-schedule";

const NOW = new Date("2026-08-04T00:00:00.000Z");

/** 构造可覆盖阶段字段的最小任务快照。 */
function createRow(
  overrides: Partial<VideoQueueScheduleRow> = {}
): VideoQueueScheduleRow {
  return {
    id: "video-1",
    stage: "created",
    stateVersion: 2,
    nextPollAt: NOW,
    claimExpiresAt: null,
    submitStartedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("video queue schedule", () => {
  it("created 与 polling 使用数据库 nextPollAt", () => {
    const nextPollAt = new Date(NOW.getTime() + 15_000);
    expect(
      resolveVideoQueueSchedule(
        createRow({ stage: "polling", nextPollAt }),
        NOW
      )
    ).toEqual({ taskId: "video-1", stateVersion: 2, runAt: nextPollAt });
  });

  it("未过期 claim 推迟重复消息，避免并发抢占", () => {
    const claimExpiresAt = new Date(NOW.getTime() + 60_000);
    expect(
      resolveVideoQueueSchedule(createRow({ claimExpiresAt }), NOW)?.runAt
    ).toEqual(claimExpiresAt);
  });

  it("charged 与 submitting 等待安全观察窗口", () => {
    expect(
      resolveVideoQueueSchedule(createRow({ stage: "charged" }), NOW)?.runAt
    ).toEqual(new Date(NOW.getTime() + VIDEO_SUBMISSION_RECOVERY_GRACE_MS));
    const submitStartedAt = new Date(NOW.getTime() - 5_000);
    expect(
      resolveVideoQueueSchedule(
        createRow({ stage: "submitting", submitStartedAt }),
        NOW
      )?.runAt
    ).toEqual(
      new Date(
        submitStartedAt.getTime() + VIDEO_SUBMISSION_RECOVERY_GRACE_MS
      )
    );
  });

  it("终态与人工核对态停止自动投递", () => {
    for (const stage of ["completed", "failed", "submit_uncertain"]) {
      expect(resolveVideoQueueSchedule(createRow({ stage }), NOW)).toBeNull();
    }
  });
});
