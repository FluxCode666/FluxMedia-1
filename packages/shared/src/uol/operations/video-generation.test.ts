/**
 * 视频生成 UOL 契约测试。
 *
 * 职责：验证生成请求必须有 Principal 作用域内的 clientRequestId，查询只接收任务 ID，
 * 且旧成员身份和对话字段无法进入严格输入。
 */
import { describe, expect, it } from "vitest";

import { getOperation } from "../registry";
import {
  videoGenerateInputSchema,
  videoGetStatusInputSchema,
} from "./video-generation";

describe("video generation operations", () => {
  it("requires a non-empty clientRequestId", () => {
    const base = {
      prompt: "海边日落",
      model: "firefly-sora2-4s-16x9",
    };
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        clientRequestId: "request-1",
      }).success
    ).toBe(true);
    expect(videoGenerateInputSchema.safeParse(base).success).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, clientRequestId: " " })
        .success
    ).toBe(false);
  });

  it.each([
    "memberType",
    "adobeId",
    "adobeSourced",
    "previousResponseId",
    "agentConfig",
  ])("rejects client-controlled legacy field %s", (field) => {
    expect(
      videoGenerateInputSchema.safeParse({
        prompt: "海边日落",
        model: "firefly-sora2-4s-16x9",
        clientRequestId: "request-1",
        [field]: "legacy",
      }).success
    ).toBe(false);
  });

  it("registers generate and owner-scoped status operations", () => {
    expect(getOperation("video.generate")?.input).toBe(
      videoGenerateInputSchema
    );
    expect(getOperation("video.getStatus")?.input).toBe(
      videoGetStatusInputSchema
    );
    expect(getOperation("video.getStatus")?.access).toEqual({
      kind: "owner",
      resource: "video task",
    });
  });
});
