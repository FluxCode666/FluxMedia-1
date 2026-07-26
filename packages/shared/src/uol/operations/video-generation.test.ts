/**
 * 视频生成 UOL 契约测试。
 *
 * 职责：验证生成请求必须有 Principal 作用域内的 clientRequestId，查询只接收任务 ID，
 * 且旧成员身份和对话字段无法进入严格输入。
 */
import { describe, expect, it } from "vitest";

import type { Principal } from "../principal";
import { getOperation } from "../registry";
import {
  videoGenerate,
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

  it("限制视频输入图最多三张", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    expect(
      videoGenerateInputSchema.safeParse({
        prompt: "海边日落",
        model: "firefly-sora2-4s-16x9",
        clientRequestId: "request-1",
        inputImages: [image, image, image, image],
      }).success
    ).toBe(false);
  });

  it.each([
    "memberType",
    "adobeId",
    ["adobe", "Sourced"].join(""),
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

  it("按凭据来源区分外部 API 与 MCP 的视频能力", () => {
    const requirement = videoGenerate.capabilities?.[0];
    if (!requirement || !("derive" in requirement)) {
      throw new Error("video.generate 缺少动态套餐能力声明");
    }
    const input = {
      clientRequestId: "request-1",
      prompt: "海边日落",
      model: "firefly-sora2-4s-16x9",
    };
    const externalPrincipal = {
      type: "apiKey",
      credentialKind: "external",
      userId: "user-1",
      apiKeyId: "external-key-1",
      plan: "pro",
    } satisfies Principal;
    const mcpPrincipal = {
      type: "apiKey",
      credentialKind: "mcp",
      userId: "user-1",
      apiKeyId: "mcp-key-1",
      plan: "pro",
    } satisfies Principal;

    expect(requirement.derive(input, externalPrincipal)).toEqual([
      "externalApi.videos.generate",
    ]);
    expect(requirement.derive(input, mcpPrincipal)).toEqual([
      "imageGeneration.video",
    ]);
  });
});
