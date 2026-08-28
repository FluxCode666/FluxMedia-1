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

  it("接受 SSE 完成事件中带部署桶名的站内存储地址", async () => {
    const imageUrl =
      "/api/storage/fluxmedia-generations/user/image.png?sig=deadbeef&exp=1785123869";
    const response = new Response(
      `: open 1785120042799\n\n: ping 1785120047799\n\ndata: ${JSON.stringify({
        type: "completed",
        generationId: "generation-relative-url",
        imageUrl,
        imageOutputs: [{ imageUrl, outputRole: "final" }],
        creditsConsumed: 1.27,
      })}\n\ndata: {"type":"done"}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      generationId: "generation-relative-url",
      imageUrl,
      imageOutputs: [{ imageUrl }],
      creditsConsumed: 1.27,
    });
  });

  it("拒绝 SSE 完成事件中的非图片协议地址", async () => {
    const response = new Response(
      'data: {"type":"completed","imageUrl":"javascript:alert(1)"}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(readGenerationResponse(response)).rejects.toThrow(
      "图片服务返回了无效流事件"
    );
  });

  it.each([
    "/api/storage/../dashboard/generate",
    "/api/storage/%2e%2e/dashboard/generate",
    "//local.invalid/api/storage/user/image.png",
    "/\\local.invalid/api/storage/user/image.png",
  ])("拒绝非站内存储相对地址：%s", async (imageUrl) => {
    const response = new Response(
      `data: ${JSON.stringify({ type: "completed", imageUrl })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }
    );

    await expect(readGenerationResponse(response)).rejects.toThrow(
      "图片服务返回了无效流事件"
    );
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

  it("接受异步任务已被 Worker 领取时的 running 状态", async () => {
    const response = new Response(
      JSON.stringify({
        taskId: "task_running",
        generationId: "generation-running",
        status: "running",
      }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      taskId: "task_running",
      status: "running",
    });
  });

  it("接受异步任务排队响应中的 null 错误字段", async () => {
    const response = new Response(
      JSON.stringify({
        taskId: "task_queued",
        generationId: "generation-queued",
        status: "queued",
        error: null,
      }),
      { status: 202, headers: { "Content-Type": "application/json" } }
    );

    await expect(readGenerationResponse(response)).resolves.toMatchObject({
      taskId: "task_queued",
      status: "queued",
      error: null,
    });
  });
});
