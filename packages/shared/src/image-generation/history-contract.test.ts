/**
 * 统一生成历史共享契约测试。
 *
 * 覆盖调用方身份注入、自然日边界、筛选枚举和 image/video 判别字段，保证 Web、
 * UOL 与未来 Agent 入口共享同一份机器契约。
 */

import { describe, expect, it } from "vitest";
import {
  adminHistoryListInputSchema,
  adminHistoryListOutputSchema,
  historyListInputSchema,
  historyListOutputSchema,
} from "./history-contract";

describe("history contract", () => {
  it("normalizes optional filters without accepting caller identity", () => {
    expect(historyListInputSchema.parse({})).toEqual({
      createdFrom: null,
      createdTo: null,
      model: null,
      status: null,
      type: null,
      cursor: null,
      limit: 20,
    });
    expect(
      historyListInputSchema.safeParse({ userId: "forged-user" }).success
    ).toBe(false);
  });

  it("rejects invalid or reversed local calendar ranges", () => {
    expect(
      historyListInputSchema.safeParse({ createdFrom: "2026-02-30" }).success
    ).toBe(false);
    expect(
      historyListInputSchema.safeParse({
        createdFrom: "2026-07-23",
        createdTo: "2026-07-22",
      }).success
    ).toBe(false);
  });

  it("accepts exact model, status, type, cursor and bounded limit", () => {
    expect(
      historyListInputSchema.parse({
        createdFrom: "2026-07-01",
        createdTo: "2026-07-22",
        model: "  gpt-image-2  ",
        status: "completed",
        type: "image",
        cursor: "signed-cursor",
        limit: 50,
      })
    ).toMatchObject({ model: "gpt-image-2", limit: 50 });
    expect(historyListInputSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(
      historyListInputSchema.safeParse({ status: "running" }).success
    ).toBe(false);
  });

  it("keeps the global user email filter exclusive to the admin contract", () => {
    expect(
      historyListInputSchema.safeParse({ userEmail: "member@example.com" })
        .success
    ).toBe(false);
    expect(
      adminHistoryListInputSchema.parse({ userEmail: " member@example.com " })
    ).toMatchObject({ userEmail: "member@example.com", limit: 20 });
    expect(
      adminHistoryListInputSchema.safeParse({ userEmail: "not-an-email" })
        .success
    ).toBe(false);
  });

  it("keeps image and video detail fields mutually exclusive", () => {
    const common = {
      id: "record-1",
      prompt: "prompt",
      model: "model-1",
      status: "completed" as const,
      creditsConsumed: 10,
      error: null,
      createdAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:01:00.000Z",
      processingDurationSeconds: 60,
    };
    const parsed = historyListOutputSchema.parse({
      asOf: "2026-07-22T02:00:00.000Z",
      records: [
        {
          ...common,
          kind: "image",
          revisedPrompt: null,
          size: "1024x1024",
          creditDetails: null,
          promptRepairNotice: null,
          referenceImages: [],
          imageUrl: "/api/storage/generations/user/output.png",
        },
        {
          ...common,
          id: "record-2",
          kind: "video",
          resolution: "1080p",
          duration: 8,
          aspectRatio: "16x9",
          generateAudio: true,
          input: { mode: "first-last-frames", count: 2 },
          videoUrl: "/api/storage/generations/user/output.mp4",
        },
      ],
      modelOptions: ["model-1"],
      nextCursor: null,
      previousCursor: null,
    });

    expect(parsed.records.map((record) => record.kind)).toEqual([
      "image",
      "video",
    ]);
    expect(
      historyListOutputSchema.safeParse({
        ...parsed,
        records: [
          {
            ...parsed.records[0],
            duration: 8,
          },
        ],
      }).success
    ).toBe(false);
    expect(
      historyListOutputSchema.safeParse({
        ...parsed,
        records: [
          {
            ...parsed.records[1],
            family: "sora2",
          },
        ],
      }).success
    ).toBe(false);
  });

  it("保留图片 processing 并仅让视频使用 queued 和 in_progress", () => {
    const base = {
      id: "record-status",
      prompt: "prompt",
      model: "model-1",
      creditsConsumed: 0,
      error: null,
      createdAt: "2026-07-22T01:00:00.000Z",
      completedAt: null,
      processingDurationSeconds: null,
    };
    expect(
      historyListOutputSchema.safeParse({
        asOf: "2026-07-22T02:00:00.000Z",
        records: [
          {
            ...base,
            kind: "image",
            status: "processing",
            revisedPrompt: null,
            size: "1024x1024",
            creditDetails: null,
            promptRepairNotice: null,
            referenceImages: [],
            imageUrl: null,
          },
          {
            ...base,
            id: "video-status",
            kind: "video",
            status: "queued",
            resolution: "720p",
            duration: 4,
            aspectRatio: "16:9",
            generateAudio: false,
            input: { mode: "none", count: 0 },
            videoUrl: null,
          },
        ],
        modelOptions: [],
        nextCursor: null,
        previousCursor: null,
      }).success
    ).toBe(true);
    expect(
      historyListOutputSchema.safeParse({
        asOf: "2026-07-22T02:00:00.000Z",
        records: [
          {
            ...base,
            kind: "image",
            status: "queued",
            revisedPrompt: null,
            size: "1024x1024",
            creditDetails: null,
            promptRepairNotice: null,
            referenceImages: [],
            imageUrl: null,
          },
        ],
        modelOptions: [],
        nextCursor: null,
        previousCursor: null,
      }).success
    ).toBe(false);
  });

  it("requires user and backend account identity only in the admin history output", () => {
    const record = {
      kind: "image" as const,
      id: "record-1",
      prompt: "prompt",
      revisedPrompt: null,
      model: "model-1",
      size: "1024x1024",
      status: "completed" as const,
      creditsConsumed: 10,
      creditDetails: null,
      promptRepairNotice: null,
      referenceImages: [],
      error: null,
      imageUrl: null,
      createdAt: "2026-07-22T01:00:00.000Z",
      completedAt: null,
      processingDurationSeconds: null,
    };
    expect(
      historyListOutputSchema.safeParse({
        asOf: "2026-07-22T02:00:00.000Z",
        records: [
          {
            ...record,
            backendAccount: {
              id: "backend-1",
              name: "Primary supplier",
            },
          },
        ],
        modelOptions: [],
        nextCursor: null,
        previousCursor: null,
      }).success
    ).toBe(false);
    expect(
      adminHistoryListOutputSchema.safeParse({
        asOf: "2026-07-22T02:00:00.000Z",
        records: [record],
        modelOptions: [],
        userOptions: [],
        nextCursor: null,
        previousCursor: null,
      }).success
    ).toBe(false);
    expect(
      adminHistoryListOutputSchema.parse({
        asOf: "2026-07-22T02:00:00.000Z",
        records: [
          {
            ...record,
            backendAccount: {
              id: "backend-1",
              name: "Primary supplier",
            },
            userId: "user-1",
            userEmail: "member@example.com",
          },
        ],
        modelOptions: [],
        userOptions: [{ id: "user-1", email: "member@example.com" }],
        nextCursor: null,
        previousCursor: null,
      }).records[0]
    ).toMatchObject({
      backendAccount: {
        id: "backend-1",
        name: "Primary supplier",
      },
      userEmail: "member@example.com",
    });
  });

  it("accepts only nullable non-negative integer processing durations", () => {
    const common = {
      kind: "image" as const,
      id: "record-1",
      prompt: "prompt",
      revisedPrompt: null,
      model: "model-1",
      size: "1024x1024",
      status: "completed" as const,
      creditsConsumed: 10,
      creditDetails: null,
      promptRepairNotice: null,
      referenceImages: [],
      error: null,
      imageUrl: null,
      createdAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:01:00.000Z",
    };
    const output = (processingDurationSeconds: number | null) => ({
      asOf: "2026-07-22T02:00:00.000Z",
      records: [{ ...common, processingDurationSeconds }],
      modelOptions: [],
      nextCursor: null,
      previousCursor: null,
    });

    expect(historyListOutputSchema.safeParse(output(null)).success).toBe(true);
    expect(historyListOutputSchema.safeParse(output(60)).success).toBe(true);
    expect(historyListOutputSchema.safeParse(output(-1)).success).toBe(false);
    expect(historyListOutputSchema.safeParse(output(1.5)).success).toBe(false);
  });
});
