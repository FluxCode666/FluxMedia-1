/**
 * 视频生成 UOL 契约测试。
 *
 * 职责：验证真实模型与独立参数、具名输入、动态能力发现、Principal 能力和 human-only
 * 生命周期操作；确保复合 ID、旧输入字段和敏感能力数据无法进入统一接口。
 */
import { describe, expect, it } from "vitest";

import type { Principal } from "../principal";
import { getOperation } from "../registry";
import {
  normalizeVideoGenerateInputForReplay,
  resolveCanonicalVideoGenerateInput,
  resolveCustomVideoGenerateInput,
  videoGenerate,
  videoGenerateInputSchema,
  videoGetInputs,
  videoGetStatus,
  videoGetStatusInputSchema,
  videoListCapabilities,
  videoListUncertainSubmissions,
  videoReconcileSubmission,
  videoRequestAccountInputCleanup,
} from "./video-generation";

const image = {
  source: "data" as const,
  mimeType: "image/png" as const,
  base64: Buffer.from("image").toString("base64"),
  byteLength: 5,
};

const seedanceRequest = {
  clientRequestId: "request-1",
  prompt: "海边日落",
  model: "seedance2",
  duration: 15,
  aspectRatio: "9:16",
  resolution: "480p",
} as const;

describe("video generation operations", () => {
  it("要求模型 ID、三个独立参数和 Principal 作用域请求键", () => {
    expect(videoGenerateInputSchema.safeParse(seedanceRequest).success).toBe(
      true
    );
    for (const missingField of [
      "clientRequestId",
      "duration",
      "aspectRatio",
      "resolution",
    ] as const) {
      const { [missingField]: _discarded, ...incomplete } = seedanceRequest;
      expect(videoGenerateInputSchema.safeParse(incomplete).success).toBe(
        false
      );
    }
    expect(
      videoGenerateInputSchema.safeParse({
        ...seedanceRequest,
        model: "vendor-video-x",
      }).success
    ).toBe(true);
  });

  it("自定义视频只接受注册分辨率和纯文本输入", () => {
    const parsed = videoGenerateInputSchema.parse({
      ...seedanceRequest,
      model: "vendor-video-x",
      resolution: "1080p",
    });
    expect(
      resolveCustomVideoGenerateInput(parsed, ["720p", "1080p"])
    ).toMatchObject({
      ok: true,
      capability: {
        modelId: "vendor-video-x",
        resolutions: ["720p", "1080p"],
        input: { frames: "none" },
        audio: { supported: false },
      },
    });
    expect(
      resolveCustomVideoGenerateInput({ ...parsed, resolution: "4k" }, [
        "720p",
        "1080p",
      ])
    ).toMatchObject({ ok: false, error: { field: "resolution" } });
  });

  it("按真实描述符拒绝非法时长、比例和分辨率组合", () => {
    const soraRequest = {
      ...seedanceRequest,
      model: "sora2",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "720p",
    } as const;
    expect(videoGenerateInputSchema.safeParse(soraRequest).success).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({
        ...soraRequest,
        duration: 3,
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...soraRequest,
        aspectRatio: "1:1",
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...soraRequest,
        resolution: "1080p",
      }).success
    ).toBe(false);
  });

  it("使用具名首尾帧并全局禁止与参考图混用", () => {
    const veoRequest = {
      ...seedanceRequest,
      model: "veo31",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1080p",
    } as const;
    expect(
      videoGenerateInputSchema.safeParse({
        ...veoRequest,
        firstFrame: image,
        lastFrame: image,
      }).success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({
        ...veoRequest,
        lastFrame: image,
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...veoRequest,
        firstFrame: image,
        referenceImages: [image],
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...veoRequest,
        model: "sora2",
        duration: 4,
        resolution: "720p",
        firstFrame: image,
        lastFrame: image,
      }).success
    ).toBe(false);
    expect(
      videoGenerateInputSchema.safeParse({
        ...veoRequest,
        model: "runway-gen45",
        duration: 5,
        resolution: "720p",
        firstFrame: image,
      }).success
    ).toBe(false);
  });

  it("固定参考图模型执行静态上限，Seedance 上限在动态边界解析", () => {
    const referenceRequest = {
      ...seedanceRequest,
      model: "veo31-ref",
      duration: 6,
      aspectRatio: "16:9",
      resolution: "1080p",
    } as const;
    expect(
      videoGenerateInputSchema.safeParse({
        ...referenceRequest,
        referenceImages: [image, image, image],
      }).success
    ).toBe(true);
    expect(
      videoGenerateInputSchema.safeParse({
        ...referenceRequest,
        referenceImages: [image, image, image, image],
      }).success
    ).toBe(false);

    const elevenReferences = {
      ...seedanceRequest,
      referenceImages: Array.from({ length: 11 }, () => image),
    };
    const staticallyParsed =
      videoGenerateInputSchema.safeParse(elevenReferences);
    expect(staticallyParsed.success).toBe(true);
    if (!staticallyParsed.success) return;
    expect(
      resolveCanonicalVideoGenerateInput(staticallyParsed.data, undefined)
    ).toMatchObject({
      ok: false,
      error: {
        code: "too_many_reference_images",
        field: "referenceImages",
        maximum: 10,
      },
    });
    expect(
      resolveCanonicalVideoGenerateInput(staticallyParsed.data, {
        version: 1,
        byModel: { seedance2: { maxReferenceImages: 20 } },
      })
    ).toMatchObject({
      ok: true,
      input: {
        model: "seedance2",
        generateAudio: false,
        referenceImages: expect.arrayContaining([image]),
      },
    });
  });

  it("Gemini 公共协议允许 Veo 官方的最多三张参考图", () => {
    const request = videoGenerateInputSchema.safeParse({
      ...seedanceRequest,
      model: "veo31",
      geminiModel: "veo-3.1-generate-preview",
      duration: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      referenceImages: [image, image, image],
    });
    expect(request.success).toBe(true);
    if (!request.success) return;
    expect(
      resolveCanonicalVideoGenerateInput(request.data, undefined)
    ).toMatchObject({
      ok: true,
      capability: { input: { referenceImages: { maxCount: 3 } } },
    });
    expect(
      videoGenerateInputSchema.safeParse({
        ...request.data,
        referenceImages: [image, image, image, image],
      }).success
    ).toBe(false);
  });

  it("幂等重放身份不受管理员后续降低参考图上限影响", () => {
    const twentyReferences = videoGenerateInputSchema.parse({
      ...seedanceRequest,
      referenceImages: Array.from({ length: 20 }, () => image),
    });
    const created = resolveCanonicalVideoGenerateInput(twentyReferences, {
      version: 1,
      byModel: { seedance2: { maxReferenceImages: 20 } },
    });
    expect(created.ok).toBe(true);
    expect(
      resolveCanonicalVideoGenerateInput(twentyReferences, undefined)
    ).toMatchObject({ ok: false });
    const replay = normalizeVideoGenerateInputForReplay(twentyReferences);
    expect(replay.generateAudio).toBe(false);
    expect(replay.referenceImages).toHaveLength(20);
  });

  it("声音缺省解析为模型默认值且不支持模型不能开启", () => {
    const kling = videoGenerateInputSchema.parse({
      ...seedanceRequest,
      model: "kling3",
      duration: 3,
      aspectRatio: "16:9",
      resolution: "1080p",
    });
    expect(resolveCanonicalVideoGenerateInput(kling, undefined)).toMatchObject({
      ok: true,
      input: { generateAudio: true },
    });

    const sora = videoGenerateInputSchema.parse({
      ...seedanceRequest,
      model: "sora2",
      duration: 4,
      aspectRatio: "16:9",
      resolution: "720p",
      generateAudio: false,
    });
    expect(resolveCanonicalVideoGenerateInput(sora, undefined)).toMatchObject({
      ok: true,
      input: { generateAudio: false },
    });
    expect(
      videoGenerateInputSchema.safeParse({
        ...sora,
        generateAudio: true,
      }).success
    ).toBe(false);
  });

  it.each([
    "image",
    "inputImages",
    "inputImageRole",
    "input_image_role",
    "memberType",
    "adobeId",
    "previousResponseId",
    "agentConfig",
  ])("拒绝旧输入或调用方控制的内部字段 %s", (field) => {
    expect(
      videoGenerateInputSchema.safeParse({
        ...seedanceRequest,
        [field]: field === "inputImages" ? [image] : "legacy",
      }).success
    ).toBe(false);
  });

  it("注册生成、状态、能力发现与 human-only 生命周期操作", () => {
    expect(getOperation("video.generate")?.input).toBe(
      videoGenerateInputSchema
    );
    expect(getOperation("video.getStatus")?.input).toBe(
      videoGetStatusInputSchema
    );
    expect(getOperation("video.listCapabilities")).toBe(videoListCapabilities);
    expect(getOperation("video.getInputs")).toBe(videoGetInputs);
    expect(getOperation("video.requestAccountInputCleanup")).toBe(
      videoRequestAccountInputCleanup
    );
    expect(getOperation("video.reconcileSubmission")).toBe(
      videoReconcileSubmission
    );
    expect(getOperation("video.listUncertainSubmissions")).toBe(
      videoListUncertainSubmissions
    );
    expect(videoGetInputs.agentExposure).toBe("human-only");
    expect(videoReconcileSubmission.agentExposure).toBe("human-only");
    expect(videoListUncertainSubmissions.agentExposure).toBe("human-only");
    expect(videoRequestAccountInputCleanup.agentExposure).toBe("human-only");
    expect(videoRequestAccountInputCleanup.destructive).toBe(true);
  });

  it("能力查询只返回全局能力、动态上限和配置可达性", () => {
    expect(
      videoListCapabilities.output.safeParse({
        items: [
          {
            model: "seedance2",
            displayName: "Seedance 2.0",
            durations: [4, 5, 6],
            aspectRatios: ["16:9", "9:16"],
            resolutions: ["1080p", "720p", "480p"],
            input: {
              frames: "first-and-optional-last",
              referenceImages: { maxCount: 20, configurable: true },
              framesAndReferencesMutuallyExclusive: true,
            },
            audio: { supported: true, defaultEnabled: false },
            configuredReachable: true,
            billing: [
              {
                kind: "current_quote",
                resolution: "480p",
                mode: "per_item",
                unit: "item",
                unitPrice: 3,
                quoteToken: "opaque-quote-token",
              },
            ],
          },
        ],
        limits: {
          maxMediaInputCount: 256,
          maxMediaInputBytes: 536870912,
        },
      }).success
    ).toBe(true);
    expect(
      videoListCapabilities.output.safeParse({
        items: [
          {
            model: "seedance2",
            displayName: "Seedance 2.0",
            durations: [15],
            aspectRatios: ["9:16"],
            resolutions: ["480p"],
            input: {
              frames: "first-and-optional-last",
              referenceImages: { maxCount: 20, configurable: true },
              framesAndReferencesMutuallyExclusive: true,
            },
            audio: { supported: true, defaultEnabled: false },
            configuredReachable: true,
            billing: [
              {
                kind: "current_quote",
                resolution: "480p",
                mode: "per_second",
                unit: "second",
                unitPrice: 2,
                creditsPerSecond: 2,
                quoteToken: "opaque-quote-token",
              },
            ],
            backendMemberId: "member-secret",
          },
        ],
        limits: {
          maxMediaInputCount: 256,
          maxMediaInputBytes: 536870912,
        },
      }).success
    ).toBe(false);
  });

  it("生成与状态输出仅接受视频公开四态", () => {
    const output = {
      taskId: "video-1",
      status: "in_progress",
      model: "seedance2",
      duration: 15,
      aspectRatio: "9:16",
      resolution: "480p",
      generateAudio: false,
      input: { mode: "references", count: 10 },
      billing: {
        kind: "snapshot",
        mode: "per_item",
        unit: "item",
        unitPrice: 3,
        durationSeconds: 15,
        quotedCredits: 3,
        actualCredits: 3,
      },
      error: "提交结果待核对",
      createdAt: "2026-07-26T00:00:00.000Z",
    } as const;
    expect(videoGetStatus.output.safeParse(output).success).toBe(true);
    expect(
      videoGenerate.output.safeParse({
        taskId: output.taskId,
        status: "queued",
        billing: output.billing,
      }).success
    ).toBe(true);
    expect(
      videoGenerate.output.safeParse({
        taskId: output.taskId,
        status: "failed",
        billing: { ...output.billing, actualCredits: 0 },
        error: "当前没有可用生成服务",
      }).success
    ).toBe(true);
    for (const status of [
      "pending",
      "submitting",
      "processing",
      "needs_attention",
    ]) {
      expect(
        videoGetStatus.output.safeParse({ ...output, status }).success
      ).toBe(false);
      expect(
        videoGenerate.output.safeParse({
          taskId: output.taskId,
          status,
          billing: output.billing,
        }).success
      ).toBe(false);
    }
  });

  it("视频 operation 不再声明商业套餐能力门禁", () => {
    const externalPrincipal = {
      type: "apiKey",
      credentialKind: "external",
      userId: "user-1",
      apiKeyId: "external-key-1",
    } satisfies Principal;
    const mcpPrincipal = {
      type: "apiKey",
      credentialKind: "mcp",
      userId: "user-1",
      apiKeyId: "mcp-key-1",
    } satisfies Principal;

    expect(externalPrincipal).not.toHaveProperty("plan");
    expect(mcpPrincipal).not.toHaveProperty("plan");
    expect(videoGenerate).not.toHaveProperty("capabilities");
    expect(videoListCapabilities).not.toHaveProperty("capabilities");
  });
});
