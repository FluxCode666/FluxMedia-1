/**
 * 视频生成 UOL 契约测试。
 *
 * 职责：验证生成请求必须有 Principal 作用域内的 clientRequestId，查询只接收任务 ID，
 * 且旧成员身份和对话字段无法进入严格输入。
 */
import { describe, expect, it } from "vitest";

import { assertAccess } from "../access";
import type { Principal } from "../principal";
import { getOperation } from "../registry";
import {
  videoGenerate,
  videoGenerateInputSchema,
  videoGetStatus,
  videoGetStatusInputSchema,
  videoListUncertainSubmissions,
  videoReconcileSubmission,
  videoReconcileSubmissionInputSchema,
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

  it("在创建任务前拒绝目录外的视频模型", () => {
    expect(
      videoGenerateInputSchema.safeParse({
        clientRequestId: "request-1",
        prompt: "海边日落",
        model: "unknown-video-model",
      }).success
    ).toBe(false);
  });

  it.each([true, false])("接受请求级 generateAudio=%s", (generateAudio) => {
    const parsed = videoGenerateInputSchema.safeParse({
      clientRequestId: "request-1",
      prompt: "海边日落",
      model: "firefly-seedance2-15s-9x16-480p",
      generateAudio,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.generateAudio).toBe(generateAudio);
    }
  });

  it("Kling 3.0 接受 3 秒 1080p 首尾帧和声音开关", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const parsed = videoGenerateInputSchema.safeParse({
      clientRequestId: "kling3-request-1",
      prompt: "海边日落",
      model: "firefly-kling3-3s-16x9-1080p",
      generateAudio: true,
      inputImages: [image, image],
    });

    expect(parsed.success).toBe(true);
  });

  it("Kling 3.0 Omni 区分首尾帧与最多三张参考图", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const base = {
      clientRequestId: "kling3-omni-request-1",
      prompt: "海边日落",
      model: "firefly-kling3-omni-8s-16x9-1080p",
      generateAudio: true,
    };

    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        inputImages: [image, image],
      }).success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        inputImageRole: "reference",
        inputImages: [image, image, image],
      }).success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        inputImages: [image, image, image],
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        inputImageRole: "reference",
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        inputImageRole: "reference",
        model: "firefly-kling3-8s-16x9-1080p",
        inputImages: [image],
      }).success
    ).toBe(false);
  });

  it("Kling 3.0 拒绝超出时长、分辨率和首尾帧数量的请求", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const base = {
      clientRequestId: "kling3-request-2",
      prompt: "海边日落",
    };

    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        model: "firefly-kling3-2s-16x9-1080p",
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        model: "firefly-kling3-15s-9x16-480p",
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...base,
        model: "firefly-kling3-15s-9x16-1080p",
        inputImages: [image, image, image],
      }).success
    ).toBe(false);
  });

  it("拒绝不支持音频的模型开启声音，但允许统一客户端显式传 false", () => {
    const base = {
      clientRequestId: "request-1",
      prompt: "海边日落",
      model: "firefly-sora2-4s-16x9",
    };

    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: true })
        .success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: false })
        .success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: "false" })
        .success
    ).toBe(false);
  });

  it("Runway Gen-4.5 拒绝声音和输入图，但允许显式关闭声音", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const base = {
      clientRequestId: "runway-request-1",
      prompt: "海边日落",
      model: "firefly-runway-gen45-5s-16x9",
    };

    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: true })
        .success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: false })
        .success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, inputImages: [image] })
        .success
    ).toBe(false);
  });

  it("Ray 3.14 拒绝声音和输入图，但允许显式关闭声音", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const base = {
      clientRequestId: "ray-request-1",
      prompt: "海边日落",
      model: "firefly-ray314-5s-16x9-4k",
    };

    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: true })
        .success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: false })
        .success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, inputImages: [image] })
        .success
    ).toBe(false);
  });

  it("Ray 3.14 HDR 拒绝声音和输入图，但允许显式关闭声音", () => {
    const image = {
      source: "data" as const,
      mimeType: "image/png" as const,
      base64: Buffer.from("image").toString("base64"),
      byteLength: 5,
    };
    const base = {
      clientRequestId: "ray-hdr-request-1",
      prompt: "海边日落",
      model: "firefly-ray314-hdr-5s-16x9-4k",
    };

    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: true })
        .success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, generateAudio: false })
        .success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({ ...base, inputImages: [image] })
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

  it("公开区分需要人工核对的提交不确定状态", () => {
    expect(
      videoGenerate.output.safeParse({
        taskId: "video-1",
        status: "needs_attention",
      }).success
    ).toBe(true);
    expect(
      videoGetStatus.output.safeParse({
        taskId: "video-1",
        status: "needs_attention",
        error: "提交结果待核对",
        createdAt: "2026-07-26T00:00:00.000Z",
      }).success
    ).toBe(true);
  });

  it("只允许管理员显式提交完整的人工核对结论", () => {
    expect(videoReconcileSubmission.access).toEqual({
      kind: "roles",
      roles: ["admin", "super_admin"],
    });
    expect(videoReconcileSubmission.agentExposure).toBe("human-only");
    expect(() =>
      assertAccess(videoReconcileSubmission.access, {
        type: "user",
        userId: "observer-1",
        role: "observer_admin",
      })
    ).toThrow();
    expect(() =>
      assertAccess(videoReconcileSubmission.access, {
        type: "user",
        userId: "admin-1",
        role: "admin",
      })
    ).not.toThrow();
    expect(
      videoReconcileSubmissionInputSchema.safeParse({
        outcome: "accepted",
        taskId: "video-1",
        pollUrl: "https://firefly.adobe.io/jobs/upstream-1",
        upstreamJobId: "upstream-1",
      }).success
    ).toBe(true);
    expect(
      videoReconcileSubmissionInputSchema.safeParse({
        outcome: "accepted",
        taskId: "video-1",
        pollUrl: "https://firefly.adobe.io/jobs/upstream-1",
      }).success
    ).toBe(false);
    expect(
      videoReconcileSubmissionInputSchema.safeParse({
        outcome: "not_accepted",
        taskId: "video-1",
        reason: "Adobe 控制台确认未创建任务",
      }).success
    ).toBe(true);
  });

  it("待核对列表同样只允许真实管理员且不暴露敏感字段", () => {
    expect(videoListUncertainSubmissions.access).toEqual({
      kind: "roles",
      roles: ["admin", "super_admin"],
    });
    expect(videoListUncertainSubmissions.agentExposure).toBe("human-only");
    expect(() =>
      assertAccess(videoListUncertainSubmissions.access, {
        type: "user",
        userId: "observer-1",
        role: "observer_admin",
      })
    ).toThrow();
    expect(
      videoListUncertainSubmissions.output.safeParse({
        items: [
          {
            taskId: "video-1",
            model: "firefly-sora2-4s-16x9",
            backendMemberId: "member-1",
            error: "提交响应丢失",
            submitStartedAt: "2026-07-26T00:00:00.000Z",
            createdAt: "2026-07-26T00:00:00.000Z",
            updatedAt: "2026-07-26T00:01:00.000Z",
          },
        ],
      }).success
    ).toBe(true);
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
