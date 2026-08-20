/**
 * 已下线视频创建地址测试。
 *
 * 使用方：Vitest；验证旧地址只返回 410，不会调用 UOL 或创建任务。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/shared/api-logger", () => ({
  withApiLogging: <T>(handler: T) => handler,
}));

import { postDeprecatedVideoGenerations } from "./video-deprecated";

describe("deprecated video creation handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 410 without falling back to the generations handler", async () => {
    const response = await postDeprecatedVideoGenerations(
      new Request("https://example.com/v1/videos", { method: "POST" }) as never
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: {
        code: "deprecated_endpoint",
      },
    });
  });
});
