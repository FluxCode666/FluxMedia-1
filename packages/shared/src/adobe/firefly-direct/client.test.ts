import { describe, expect, it } from "vitest";
import { AdobeFireflyClient, extractResultLink } from "./client";
import {
  AdobeAcceptedVideoError,
  AuthError,
  QuotaExhaustedError,
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
  it("提交→轮询→下载 闭环", async () => {
    const imgBytes = Buffer.from("PNGDATA");
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        // submit
        expect(req.url).toContain("/v2/3p-images/generate-async");
        expect(req.headers["x-arp-session-id"]).toBeTruthy();
        expect(req.headers["x-nonce"]).toBeTruthy();
        return jsonResponse(
          200,
          { links: { result: "https://poll/abc" } },
          { "x-override-status-link": "https://poll/abc" }
        );
      }
      // poll
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

  it("gpt-image 图生图：单候选 referenceBlobs 提交成功", async () => {
    const api = new MockTransport((req) => {
      if (req.url.includes("generate-async")) {
        return jsonResponse(
          200,
          {},
          { "x-override-status-link": "https://poll/x" }
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
    upstreamModel: "sora2",
    upstreamModelId: "sora2",
    upstreamModelVersion: "1",
    engine: "sora2",
    duration: 8,
    size: { width: 1280, height: 720 },
    generateAudio: false,
    pollIntervalMs: 1,
  };

  it("上游接受后轮询临时失败只重试原任务，不重复提交", async () => {
    const videoBytes = Buffer.from("MP4DATA");
    const api = new MockTransport((req, index) => {
      if (index === 0) {
        expect(req.url).toContain("/v2/3p-videos/generate-async");
        return jsonResponse(
          200,
          {},
          { "x-override-status-link": "https://poll/video-1" }
        );
      }
      if (index === 1) {
        expect(req.url).toBe("https://poll/video-1");
        return jsonResponse(503, { error: "temporary" });
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
            { "x-override-status-link": "https://poll/video-2" }
          )
        : jsonResponse(401, {})
    );
    const client = new AdobeFireflyClient({ transport: api });

    await expect(client.generateVideo(videoInput)).rejects.toBeInstanceOf(
      AdobeAcceptedVideoError
    );
    expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
