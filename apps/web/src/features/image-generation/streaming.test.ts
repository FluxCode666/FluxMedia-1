import { describe, expect, it } from "vitest";

import { createImageStreamResponse } from "./streaming";

async function readFirstChunk(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

describe("image stream response", () => {
  it("sets no-buffer headers for proxied SSE", async () => {
    const response = createImageStreamResponse(async () => null);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(
      "no-store"
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("sends an initial padded chunk to encourage immediate flush", async () => {
    const response = createImageStreamResponse(async () => null);
    const firstChunk = await readFirstChunk(response);

    expect(firstChunk).toContain(": open");
    expect(firstChunk.length).toBeGreaterThan(1024);
  });

  it("允许页面接口为未捕获异常提供安全的错误文案", async () => {
    const response = createImageStreamResponse(
      async () => {
        throw new Error("Upstream Images API returned HTTP 401: Bearer secret");
      },
      { formatError: () => "图片服务暂时不可用，请稍后重试" }
    );
    const body = await response.text();

    expect(body).toContain("图片服务暂时不可用，请稍后重试");
    expect(body).not.toContain("Bearer secret");
  });

  it("keeps the route work running after the client closes the stream", async () => {
    let releaseRun: (() => void) | undefined;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let completed = false;

    const response = createImageStreamResponse(async (emit) => {
      await emit({ type: "partial_image", b64_json: "c3RhcnRlZA==" });
      await runReleased;
      completed = true;
      return { type: "completed", generationId: "gen_1" };
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    await reader.read();
    await reader.cancel();
    releaseRun?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completed).toBe(true);
  });

  it("settles the start finally cleanly when cancel races the close guard", async () => {
    let releaseRun: (() => void) | undefined;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    // Surface any throw escaping the start() finally (e.g. controller.close()
    // racing cancel()) so the guarded close() actually keeps the run quiet.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      const response = createImageStreamResponse(async () => {
        await runReleased;
        return { type: "completed", generationId: "gen_race" };
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing response body");

      // Cancel before the run resolves so start()'s finally runs on an already
      // cancelled controller, exercising the close() fallback.
      await reader.read();
      await reader.cancel();
      releaseRun?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
