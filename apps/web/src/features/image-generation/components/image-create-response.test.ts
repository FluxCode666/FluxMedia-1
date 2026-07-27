/**
 * 简易生图页响应解析测试。
 *
 * 职责：验证 SSE keep-alive、完成事件、错误事件和普通 JSON 回退，不访问网络。
 */

import { describe, expect, it } from "vitest";

import { readGenerationResponse } from "./image-create-response";

describe("image create response", () => {
  it("忽略 SSE 心跳并返回完成事件", async () => {
    const response = new Response(
      ': open\n\n: ping\n\ndata: {"type":"completed","generationId":"generation-1","imageUrl":"https://cdn.example.test/image.png","creditsConsumed":2}\n\ndata: {"type":"done"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      generationId: "generation-1",
      imageUrl: "https://cdn.example.test/image.png",
      creditsConsumed: 2,
    });
  });

  it("保留 SSE 结构化错误", async () => {
    const response = new Response(
      'data: {"type":"error","error":"upstream failed","generationId":"generation-2"}\n\ndata: {"type":"done"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      error: "upstream failed",
      generationId: "generation-2",
    });
  });

  it("继续兼容普通 JSON 响应", async () => {
    const response = new Response(
      JSON.stringify({
        generationId: "generation-3",
        imageUrl: "https://cdn.example.test/image.png",
      }),
      { headers: { "Content-Type": "application/json" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      generationId: "generation-3",
    });
  });
});
