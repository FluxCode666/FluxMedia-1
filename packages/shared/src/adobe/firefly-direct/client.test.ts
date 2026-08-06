import { describe, expect, it } from "vitest";
import {
  AdobeFireflyClient,
  extractResultLink,
  normalizeVideoPollUrl,
} from "./client";
import {
  AdobeAcceptedVideoError,
  AdobeVideoSubmissionUncertainError,
  AuthError,
  QuotaExhaustedError,
  UpstreamTemporaryError,
} from "./errors";
import type {
  FireflyTransport,
  FireflyTransportRequest,
  FireflyTransportResponse,
} from "./transport";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): FireflyTransportResponse {
  const buf = Buffer.from(JSON.stringify(body), "utf-8");
  return {
    status,
    headers,
    bytes: async () => buf,
    text: async () => buf.toString("utf-8"),
    json: async () => JSON.parse(buf.toString("utf-8")),
  };
}

function bytesResponse(status: number, data: Buffer): FireflyTransportResponse {
  return {
    status,
    headers: {},
    bytes: async () => data,
    text: async () => data.toString("utf-8"),
    json: async () => JSON.parse(data.toString("utf-8")),
  };
}

class MockTransport implements FireflyTransport {
  calls: FireflyTransportRequest[] = [];
  constructor(
    private readonly handler: (
      req: FireflyTransportRequest,
      index: number
    ) => FireflyTransportResponse
  ) {}
  async request(
    req: FireflyTransportRequest
  ): Promise<FireflyTransportResponse> {
    const res = this.handler(req, this.calls.length);
    this.calls.push(req);
    return res;
  }
}

const FAKE_TOKEN = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
  '{"user_id":"u1"}'
).toString("base64url")}.sig`;

describe("extractResultLink", () => {
  it("优先响应头 x-override-status-link", () => {
    expect(
      extractResultLink(
        { "x-override-status-link": "https://poll/1" },
        { links: { result: "https://poll/2" } }
      )
    ).toBe("https://poll/1");
  });
  it("回落 body.links.result（字符串/对象）", () => {
    expect(extractResultLink({}, { links: { result: "https://poll/2" } })).toBe(
      "https://poll/2"
    );
    expect(
      extractResultLink({}, { links: { result: { href: "https://poll/3" } } })
    ).toBe("https://poll/3");
  });
  it("无则返回空", () => {
    expect(extractResultLink({}, {})).toBe("");
  });
});

describe("AdobeFireflyClient.generateImage", () => {
  it("每次图片提交前暴露本次实际请求正文", async () => {
    const requestBodies: unknown[] = [];
    const api = new MockTransport((request) => {
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toEqual(JSON.parse(String(request.body)));
      return jsonResponse(401, {});
    });
    const client = new AdobeFireflyClient({ transport: api });

    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "a cat",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
        onRequestBody: (body) => {
          requestBodies.push(body);
        },
      })
    ).rejects.toBeInstanceOf(AuthError);

    expect(requestBodies[0]).toMatchObject({
      modelId: "gpt-image",
      modelVersion: "2",
      prompt: "a cat",
    });
  });

  it("提交→轮询→下载 闭环", async () => {
    const imgBytes = Buffer.from("PNGDATA");
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        // submit
        expect(req.url).toContain("/v2/3p-images/generate-async");
        expect(req.headers.origin).toBe("https://new.express.adobe.com");
        expect(req.headers.referer).toBe("https://new.express.adobe.com/");
        expect(req.headers["sec-fetch-site"]).toBe("cross-site");
        expect(req.headers["x-api-key"]).toBe("projectx_webapp");
        expect(req.headers["x-arp-session-id"]).toBeUndefined();
        expect(req.headers["x-nonce"]).toBeUndefined();
        return jsonResponse(
          200,
          {
            links: {
              result:
                "https://firefly-epo855232.adobe.io/jobs/result/image-abc",
            },
          },
          {
            "x-override-status-link":
              "https://firefly-epo855232.adobe.io/jobs/result/image-abc",
          }
        );
      }
      // poll
      expect(req.url).toBe(
        "https://bks-epo8552.adobe.io/v2/jobs/result/image-abc?host=firefly-epo855232.adobe.io/"
      );
      return jsonResponse(200, {
        status: "COMPLETED",
        outputs: [{ image: { presignedUrl: "https://cdn/img.png" } }],
      });
    });
    const download = new MockTransport(() => bytesResponse(200, imgBytes));
    const client = new AdobeFireflyClient({
      transport: api,
      downloadTransport: download,
    });

    const out = await client.generateImage({
      token: FAKE_TOKEN,
      prompt: "a cat",
      aspectRatio: "16:9",
      outputResolution: "2K",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "2",
      pollIntervalMs: 1,
    });
    expect(out.bytes.toString("utf-8")).toBe("PNGDATA");
    expect(download.calls[0]?.url).toBe("https://cdn/img.png");
  });

  it("401 taste_exhausted → QuotaExhaustedError", async () => {
    const api = new MockTransport(() =>
      jsonResponse(401, {}, { "x-access-error": "taste_exhausted" })
    );
    const client = new AdobeFireflyClient({ transport: api });
    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "x",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("401 普通 → AuthError", async () => {
    const api = new MockTransport(() => jsonResponse(401, {}));
    const client = new AdobeFireflyClient({ transport: api });
    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "x",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("408 system under load → UpstreamTemporaryError", async () => {
    const api = new MockTransport(() =>
      jsonResponse(408, {
        error_code: "timeout_error",
        message: "system under load",
      })
    );
    const client = new AdobeFireflyClient({ transport: api });
    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "x",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).rejects.toBeInstanceOf(UpstreamTemporaryError);
  });

  it("轮询 451 image_unsafe → 内容安全业务拒绝", async () => {
    const api = new MockTransport((_req, index) => {
      if (index === 0) {
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-epo8552.adobe.io/jobs/result/image-unsafe",
          }
        );
      }
      return jsonResponse(451, {
        error_code: "image_unsafe",
        message:
          "The generated images appear to be unsafe. Try modifying the prompts or the seeds.",
      });
    });
    const client = new AdobeFireflyClient({ transport: api });

    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "unsafe prompt",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).rejects.toMatchObject({
      name: "AdobeContentSafetyError",
      businessError: true,
      statusCode: 451,
      adobeErrorCode: "image_unsafe",
      userMessage: "提示词未通过内容安全审核，请修改提示词后重试。",
    });
  });

  it("拒绝上游返回的非 Adobe 轮询地址", async () => {
    const api = new MockTransport(() =>
      jsonResponse(
        200,
        {},
        {
          "x-override-status-link":
            "https://firefly-epo855232.adobe.io.evil.test/jobs/result/1",
        }
      )
    );
    const client = new AdobeFireflyClient({ transport: api });
    await expect(
      client.generateImage({
        token: FAKE_TOKEN,
        prompt: "x",
        aspectRatio: "1:1",
        outputResolution: "2K",
        upstreamModelId: "gpt-image",
        upstreamModelVersion: "2",
      })
    ).rejects.toThrow("Adobe 轮询地址不受信任");
  });

  it("gpt-image 图生图：单候选 referenceBlobs 提交成功", async () => {
    const api = new MockTransport((req) => {
      if (req.url.includes("generate-async")) {
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-3p.ff.adobe.io/v2/status/image-x",
          }
        );
      }
      return jsonResponse(200, {
        outputs: [{ image: { presignedUrl: "https://cdn/y.png" } }],
      });
    });
    const download = new MockTransport(() =>
      bytesResponse(200, Buffer.from("Y"))
    );
    const client = new AdobeFireflyClient({
      transport: api,
      downloadTransport: download,
    });
    const out = await client.generateImage({
      token: FAKE_TOKEN,
      prompt: "edit",
      aspectRatio: "1:1",
      outputResolution: "2K",
      upstreamModelId: "gpt-image",
      upstreamModelVersion: "2",
      sourceImageIds: ["img1"],
      pollIntervalMs: 1,
    });
    expect(out.bytes.toString("utf-8")).toBe("Y");
    // 现在 gpt-image 图生图只有一个 referenceBlobs 候选,一次 submit 即可。
    const submits = api.calls.filter((c) => c.url.includes("generate-async"));
    expect(submits.length).toBe(1);
  });
});

describe("AdobeFireflyClient.generateVideo", () => {
  const videoInput = {
    token: FAKE_TOKEN,
    prompt: "a moving cat",
    model: "sora2" as const,
    duration: 8,
    aspectRatio: "16:9" as const,
    resolution: "720p" as const,
    size: { width: 1280, height: 720 },
    effectiveAudio: false,
    pollIntervalMs: 1,
  };

  it("视频提交前暴露本次实际请求正文", async () => {
    const requestBodies: unknown[] = [];
    const api = new MockTransport((request) => {
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toEqual(JSON.parse(String(request.body)));
      return jsonResponse(401, {});
    });
    const client = new AdobeFireflyClient({ transport: api });

    await expect(
      client.submitVideo({
        ...videoInput,
        onRequestBody: (body) => {
          requestBodies.push(body);
        },
      })
    ).rejects.toBeInstanceOf(AuthError);

    expect(requestBodies[0]).toMatchObject({
      modelId: expect.any(String),
      duration: 8,
    });
    const requestBody = requestBodies[0] as { prompt?: unknown };
    expect(JSON.parse(String(requestBody.prompt))).toMatchObject({
      prompt_text: "a moving cat",
      duration_sec: 8,
    });
  });

  it("上游接受后轮询 408 只重试原任务，不重复提交", async () => {
    const videoBytes = Buffer.from("MP4DATA");
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        expect(req.url).toContain("/v2/3p-videos/generate-async");
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-3p.ff.adobe.io/v2/status/video-1",
          }
        );
      }
      if (index === 1) {
        expect(req.url).toBe(
          "https://firefly-3p.ff.adobe.io/v2/status/video-1"
        );
        return jsonResponse(408, {
          error_code: "timeout_error",
          message: "system under load",
        });
      }
      return jsonResponse(200, {
        status: "COMPLETED",
        outputs: [{ video: { presignedUrl: "https://cdn/video.mp4" } }],
      });
    });
    const download = new MockTransport(() => bytesResponse(200, videoBytes));
    const client = new AdobeFireflyClient({
      transport: api,
      downloadTransport: download,
    });

    const output = await client.generateVideo(videoInput);

    expect(output.bytes).toEqual(videoBytes);
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("上游接受后的授权失败带明确阶段标记", async () => {
    const api = new MockTransport((_req, index) =>
      index === 0
        ? jsonResponse(
            200,
            {},
            {
              "x-override-status-link":
                "https://firefly-3p.ff.adobe.io/v2/status/video-2",
            }
          )
        : jsonResponse(401, {})
    );
    const client = new AdobeFireflyClient({ transport: api });

    await expect(client.generateVideo(videoInput)).rejects.toBeInstanceOf(
      AdobeAcceptedVideoError
    );
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("视频提交 408 在任务未接受前按临时错误返回", async () => {
    const client = new AdobeFireflyClient({
      transport: new MockTransport(() =>
        jsonResponse(408, {
          error_code: "timeout_error",
          message: "system under load",
        })
      ),
    });

    await expect(client.submitVideo(videoInput)).rejects.toBeInstanceOf(
      UpstreamTemporaryError
    );
  });

  it("视频提交接受无 v2 前缀的 EPO jobs 轮询地址", async () => {
    const client = new AdobeFireflyClient({
      transport: new MockTransport(() =>
        jsonResponse(
          200,
          { id: "job-video-legacy-path" },
          {
            "x-override-status-link":
              "https://firefly-epo5678-prod.adobe.io/jobs/video-legacy-path",
          }
        )
      ),
    });

    await expect(client.submitVideo(videoInput)).resolves.toMatchObject({
      pollUrl:
        "https://bks-epo5678.adobe.io/v2/jobs/result/video-legacy-path?host=firefly-epo5678-prod.adobe.io/",
      upstreamJobId: "job-video-legacy-path",
    });
  });

  it("提交、单次轮询和下载可作为独立恢复阶段调用", async () => {
    const videoBytes = Buffer.from("RECOVERED-MP4");
    const rawPollUrl = "https://firefly-epo1234-prod.adobe.io/v2/jobs/video-3";
    const pollUrl =
      "https://bks-epo1234.adobe.io/v2/jobs/result/video-3?host=firefly-epo1234-prod.adobe.io/";
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        return jsonResponse(
          200,
          { id: "job-video-3" },
          { "x-override-status-link": rawPollUrl }
        );
      }
      expect(req.url).toBe(pollUrl);
      return index === 1
        ? jsonResponse(
            200,
            {
              progress: 80,
              outputs: [
                {
                  video: {
                    presignedUrl: "https://cdn.example/video-early.mp4",
                  },
                },
              ],
            },
            { "x-task-status": "IN_PROGRESS" }
          )
        : jsonResponse(200, {
            status: "COMPLETED",
            outputs: [
              { video: { presignedUrl: "https://cdn.example/video-3.mp4" } },
            ],
          });
    });
    const download = new MockTransport(() => bytesResponse(200, videoBytes));
    const client = new AdobeFireflyClient({
      transport: api,
      downloadTransport: download,
    });

    const submitted = await client.submitVideo(videoInput);
    expect(submitted).toMatchObject({ pollUrl, upstreamJobId: "job-video-3" });
    await expect(
      client.pollVideo({ token: FAKE_TOKEN, pollUrl })
    ).resolves.toMatchObject({ status: "pending" });
    const completed = await client.pollVideo({ token: FAKE_TOKEN, pollUrl });
    expect(completed).toMatchObject({
      status: "completed",
      videoUrl: "https://cdn.example/video-3.mp4",
    });
    if (completed.status !== "completed") {
      throw new Error("测试夹具必须返回 completed");
    }
    await expect(client.downloadVideo(completed.videoUrl)).resolves.toEqual(
      videoBytes
    );
  });

  it("已返回成功但缺少轮询地址时标记提交结果不确定", async () => {
    const client = new AdobeFireflyClient({
      transport: new MockTransport(() => jsonResponse(200, { id: "job" })),
    });

    await expect(client.submitVideo(videoInput)).rejects.toBeInstanceOf(
      AdobeVideoSubmissionUncertainError
    );
  });

  it("持久轮询地址拒绝不可信主机、端口、凭据和 BKS 篡改", async () => {
    const client = new AdobeFireflyClient({
      transport: new MockTransport(() =>
        jsonResponse(200, { status: "RUNNING" })
      ),
    });

    const blocked = [
      "http://firefly-epo1234.adobe.io/jobs/1",
      "https://user:password@firefly-epo1234.adobe.io/jobs/1",
      "https://firefly-epo1234.adobe.io:444/jobs/1",
      "https://firefly-epo1234.adobe.io/jobs/1#fragment",
      "https://firefly-3p.ff.adobe.io.evil.test/status/1",
      "https://bks-epo1234.adobe.io/v2/jobs/result/1?host=evil.test",
      "https://bks-epo1234.adobe.io/v2/jobs/result/1?host=firefly-epo9999.adobe.io",
      "https://bks-epo1234.adobe.io/v2/jobs/result/1?host=firefly-epo1234.adobe.io&extra=1",
      "https://bks-epo1234.adobe.io/v2/jobs/result/1/extra?host=firefly-epo1234.adobe.io",
    ];
    for (const pollUrl of blocked) {
      await expect(
        client.pollVideo({ token: FAKE_TOKEN, pollUrl })
      ).rejects.toThrow("Adobe 视频轮询地址不受信任");
    }
  });

  it("将 firefly 分片轮询地址规范化为 bks 地址", () => {
    expect(
      normalizeVideoPollUrl(
        "https://firefly-epo1234-prod.adobe.io/v2/status/job-1"
      )
    ).toBe(
      "https://bks-epo1234.adobe.io/v2/jobs/result/job-1?host=firefly-epo1234-prod.adobe.io/"
    );
    expect(
      normalizeVideoPollUrl("https://bks-epo1234.adobe.io/v2/status/job-1")
    ).toBe("https://bks-epo1234.adobe.io/v2/status/job-1");
    expect(normalizeVideoPollUrl("not a url")).toBe("not a url");
  });

  it("视频生成实际轮询时使用规范化后的 bks 地址", async () => {
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-epo5678-prod.adobe.io/jobs/video-job-2",
          }
        );
      }
      expect(req.url).toBe(
        "https://bks-epo5678.adobe.io/v2/jobs/result/video-job-2?host=firefly-epo5678-prod.adobe.io/"
      );
      return jsonResponse(200, {
        status: "COMPLETED",
        outputs: [{ video: { presignedUrl: "https://cdn/video.mp4" } }],
      });
    });
    const download = new MockTransport(() =>
      bytesResponse(200, Buffer.from("MP4DATA"))
    );
    const client = new AdobeFireflyClient({
      transport: api,
      downloadTransport: download,
    });

    const output = await client.generateVideo(videoInput);

    expect(output.bytes.toString("utf-8")).toBe("MP4DATA");
    expect(download.calls[0]?.url).toBe("https://cdn/video.mp4");
  });

  it("视频提交和轮询均发送 Express 请求头", async () => {
    const api = new MockTransport((_req, index) =>
      index === 0
        ? jsonResponse(
            200,
            {},
            {
              "x-override-status-link":
                "https://firefly-epo1234-prod.adobe.io/v2/status/video-headers",
            }
          )
        : jsonResponse(200, { status: "RUNNING" })
    );
    const client = new AdobeFireflyClient({ transport: api });

    const submitted = await client.submitVideo(videoInput);
    await client.pollVideo({
      token: FAKE_TOKEN,
      pollUrl: submitted.pollUrl,
    });

    expect(api.calls[0]?.headers.origin).toBe("https://new.express.adobe.com");
    expect(api.calls[0]?.headers.referer).toBe(
      "https://new.express.adobe.com/"
    );
    expect(api.calls[0]?.headers["sec-fetch-site"]).toBe("cross-site");
    expect(api.calls[0]?.headers["x-api-key"]).toBe("projectx_webapp");
    expect(api.calls[0]?.headers["x-arp-session-id"]).toBeTruthy();
    expect(api.calls[0]?.headers["x-nonce"]).toMatch(/^[a-f0-9]{64}$/);
    expect(api.calls[1]?.headers.origin).toBe("https://new.express.adobe.com");
    expect(api.calls[1]?.headers["x-arp-session-id"]).toBeUndefined();
    expect(api.calls[1]?.headers["x-nonce"]).toBeUndefined();
  });

  it("Seedance client 原样提交二十张有序参考图", async () => {
    const referenceImageIds = Array.from(
      { length: 20 },
      (_, index) => `reference-${String(index + 1).padStart(2, "0")}`
    );
    const api = new MockTransport((req) => {
      expect(req.url).toContain("/v2/3p-videos/generate-async");
      const payload = JSON.parse(String(req.body)) as Record<string, unknown>;
      expect(payload.referenceBlobs).toEqual(
        referenceImageIds.map((id) => ({ id, usage: "style" }))
      );
      expect(payload).not.toHaveProperty("referenceFrames");
      return jsonResponse(
        200,
        {},
        {
          "x-override-status-link":
            "https://firefly-epo1234-prod.adobe.io/v2/status/video-seedance-references",
        }
      );
    });
    const client = new AdobeFireflyClient({
      webApp: "firefly",
      transport: api,
    });

    await client.submitVideo({
      ...videoInput,
      model: "seedance2",
      duration: 4,
      resolution: "480p",
      size: { width: 854, height: 480 },
      referenceImageIds,
    });

    expect(api.calls).toHaveLength(1);
  });

  it("Kling 3.0 的上传、提交和轮询均使用 Firefly 网页 Profile", async () => {
    const api = new MockTransport((req, index) => {
      if (index < 2) {
        expect(req.url).toContain("/v2/storage/image");
        return jsonResponse(200, {
          images: [{ id: index === 0 ? "first-frame" : "last-frame" }],
        });
      }
      if (index === 2) {
        expect(req.url).toContain("/v2/3p-videos/generate-async");
        expect(JSON.parse(String(req.body))).toMatchObject({
          modelId: "kling",
          modelVersion: "kling_v3",
          duration: 3,
          size: { width: 1920, height: 1080 },
          generateAudio: true,
          generationMetadata: { module: "image2video" },
          referenceBlobs: [
            { id: "first-frame", usage: "frame", order: 1 },
            { id: "last-frame", usage: "frame", order: 2 },
          ],
        });
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-epo1234-prod.adobe.io/v2/status/video-kling3-profile",
          }
        );
      }
      return jsonResponse(200, { status: "RUNNING" });
    });
    const client = new AdobeFireflyClient({
      webApp: "firefly",
      transport: api,
    });

    const firstFrameId = await client.uploadImage(
      FAKE_TOKEN,
      Buffer.from("first-frame")
    );
    const lastFrameId = await client.uploadImage(
      FAKE_TOKEN,
      Buffer.from("last-frame")
    );
    const submitted = await client.submitVideo({
      ...videoInput,
      model: "kling3",
      duration: 3,
      resolution: "1080p",
      size: { width: 1920, height: 1080 },
      effectiveAudio: true,
      firstFrameId,
      lastFrameId,
    });
    await client.pollVideo({
      token: FAKE_TOKEN,
      pollUrl: submitted.pollUrl,
    });

    for (const call of api.calls) {
      expect(call.headers.origin).toBe("https://firefly.adobe.com");
      expect(call.headers.referer).toBe("https://firefly.adobe.com/");
      expect(call.headers["x-api-key"]).toBe("clio-playground-web");
      expect(call.headers.Authorization ?? call.headers.authorization).toBe(
        `Bearer ${FAKE_TOKEN}`
      );
    }
  });

  it("Kling 3.0 Omni 的上传、提交和轮询均使用 Firefly 网页 Profile", async () => {
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        expect(req.url).toContain("/v2/storage/image");
        return jsonResponse(200, { images: [{ id: "reference-image" }] });
      }
      if (index === 1) {
        expect(req.url).toContain("/v2/3p-videos/generate-async");
        expect(JSON.parse(String(req.body))).toMatchObject({
          modelId: "kling",
          modelVersion: "kling_v3_omni",
          generationMetadata: { module: "image2video" },
          referenceBlobs: [{ id: "reference-image", usage: "frame", order: 1 }],
        });
        return jsonResponse(
          200,
          {},
          {
            "x-override-status-link":
              "https://firefly-epo1234-prod.adobe.io/v2/status/video-firefly-profile",
          }
        );
      }
      return jsonResponse(200, { status: "RUNNING" });
    });
    const client = new AdobeFireflyClient({
      webApp: "firefly",
      transport: api,
    });

    const imageId = await client.uploadImage(
      FAKE_TOKEN,
      Buffer.from("reference")
    );
    const submitted = await client.submitVideo({
      ...videoInput,
      model: "kling3-omni",
      firstFrameId: imageId,
    });
    await client.pollVideo({
      token: FAKE_TOKEN,
      pollUrl: submitted.pollUrl,
    });

    for (const call of api.calls) {
      expect(call.headers.origin).toBe("https://firefly.adobe.com");
      expect(call.headers.referer).toBe("https://firefly.adobe.com/");
      expect(call.headers["x-api-key"]).toBe("clio-playground-web");
      expect(call.headers.Authorization ?? call.headers.authorization).toBe(
        `Bearer ${FAKE_TOKEN}`
      );
    }
  });

  it("Ray 3.14 通过 Firefly 网页 Profile 提交完整模型专属参数", async () => {
    const api = new MockTransport((req) => {
      expect(req.url).toContain("/v2/3p-videos/generate-async");
      expect(JSON.parse(String(req.body))).toEqual({
        modelId: "luma",
        modelVersion: "3.14-ray",
        size: { width: 3840, height: 2160 },
        mode: "flex_2",
        prompt: "a moving cat",
        negativePrompt: "blurry",
        duration: 5,
        generationMetadata: {
          module: "text2video",
          submodule: "ff-video-generate",
        },
        modelSpecificPayload: {
          resolution: "4k",
          aspect_ratio: "16:9",
        },
        output: { storeInputs: true },
      });
      return jsonResponse(
        200,
        {},
        {
          "x-override-status-link":
            "https://firefly-epo1234-prod.adobe.io/v2/status/video-ray314",
        }
      );
    });
    const client = new AdobeFireflyClient({
      webApp: "firefly",
      transport: api,
    });

    await client.submitVideo({
      ...videoInput,
      model: "ray314",
      duration: 5,
      resolution: "4k",
      size: { width: 3840, height: 2160 },
      negativePrompt: "blurry",
    });

    expect(api.calls[0]?.headers.origin).toBe("https://firefly.adobe.com");
    expect(api.calls[0]?.headers.referer).toBe("https://firefly.adobe.com/");
    expect(api.calls[0]?.headers["x-api-key"]).toBe("clio-playground-web");
  });

  it("Ray 3.14 HDR 通过 Firefly Profile 提交且不携带 flex_2 mode", async () => {
    const api = new MockTransport((req) => {
      expect(req.url).toContain("/v2/3p-videos/generate-async");
      expect(JSON.parse(String(req.body))).toEqual({
        modelId: "luma",
        modelVersion: "3.14-ray-hdr",
        size: { width: 3840, height: 2160 },
        prompt: "a moving cat",
        negativePrompt: "blurry",
        duration: 5,
        generationMetadata: {
          module: "text2video",
          submodule: "ff-video-generate",
        },
        modelSpecificPayload: {
          resolution: "4k",
          aspect_ratio: "16:9",
        },
        output: { storeInputs: true },
      });
      return jsonResponse(
        200,
        {},
        {
          "x-override-status-link":
            "https://firefly-epo1234-prod.adobe.io/v2/status/video-ray314-hdr",
        }
      );
    });
    const client = new AdobeFireflyClient({
      webApp: "firefly",
      transport: api,
    });

    await client.submitVideo({
      ...videoInput,
      model: "ray314-hdr",
      duration: 5,
      resolution: "4k",
      size: { width: 3840, height: 2160 },
      negativePrompt: "blurry",
    });

    expect(api.calls[0]?.headers.origin).toBe("https://firefly.adobe.com");
    expect(api.calls[0]?.headers.referer).toBe("https://firefly.adobe.com/");
    expect(api.calls[0]?.headers["x-api-key"]).toBe("clio-playground-web");
  });
});
