/**
 * 系统文档外部视频端点契约测试。
 *
 * 使用方：Vitest；防止持久视频任务重新被描述为同步等待、进程内异步任务或旧响应字段。
 * 关键依赖：system-docs 的本地化静态数据，不渲染 React，也不访问网络或数据库。
 */
import { describe, expect, it } from "vitest";

import { getSystemDocsVideoEndpoints } from "./system-docs";

const OBSOLETE_VIDEO_RESPONSE_FIELDS = [
  '"created":',
  '"generationId":',
  '"credits_consumed":',
] as const;

describe("system docs video contract", () => {
  it.each(["zh", "en"])("%s 按当前请求域名生成视频 API 示例", (locale) => {
    const baseUrl = "https://tenant.example.test";
    const endpoints = getSystemDocsVideoEndpoints(locale, baseUrl);
    const serialized = JSON.stringify(endpoints);

    expect(serialized).toContain(baseUrl);
    expect(serialized).not.toContain("{{FLUXMEDIA_BASE_URL}}");
    expect(serialized).not.toContain("gpt2image.superapi.buzz");
  });

  it.each(["zh", "en"])("%s 精确描述持久视频创建任务", (locale) => {
    const endpoints = getSystemDocsVideoEndpoints(locale);
    const endpoint = endpoints.find(
      (item) => item.method === "POST" && item.path === "/v1/videos"
    );
    if (!endpoint) throw new Error(`${locale} 缺少视频创建文档`);

    expect(endpoint.description).toContain("HTTP 202");
    expect(endpoint.description).toMatch(/OpenAI|风格/u);
    expect(endpoint.responseExample).toContain('"object": "video.task"');
    const idMatch = endpoint.responseExample.match(/"id": "([^"]+)"/);
    if (!idMatch?.[1]) throw new Error(`${locale} 创建响应缺少任务 ID`);
    expect(idMatch[1]).toMatch(/^video_[0-9a-f]{40}$/u);
    expect(endpoint.responseExample).toContain(`"task_id": "${idMatch[1]}"`);
    expect(endpoint.responseExample).toContain(
      `"generation_id": "${idMatch[1]}"`
    );
    for (const field of OBSOLETE_VIDEO_RESPONSE_FIELDS) {
      expect(endpoint.responseExample).not.toContain(field);
    }

    const asyncField = endpoint.fields.find((field) => field.name === "async");
    const callbackField = endpoint.fields.find((field) =>
      field.name.includes("callback_url")
    );
    expect(asyncField?.description).toMatch(/兼容字段|Compatibility field/);
    expect(asyncField?.description).toMatch(/不支持|not a supported/);
    expect(callbackField?.description).toMatch(/持久任务|persistent task/);
    expect(callbackField?.description).toContain("https");
    expect(endpoint.responses.map((field) => field.name)).toEqual([
      "object",
      "id / task_id / generation_id",
      "status",
      "model",
      locale === "zh"
        ? "duration / duration_seconds、aspectRatio / aspect_ratio、resolution"
        : "duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
      "generateAudio / generate_audio",
    ]);
    expect(JSON.stringify(endpoint)).toMatch(
      /seconds \/ duration(?: \/ duration_seconds)?/u
    );
    expect(JSON.stringify(endpoint)).not.toMatch(
      /needs_attention|submitting|pending/u
    );
    const notes = endpoint.notes.join("\n");
    expect(notes).toContain("/v1/videos/generations");
    expect(notes).toContain("/api/v1/videos/generations");
    if (locale === "zh") {
      expect(notes).toContain("即将废弃下线");
      expect(notes).toContain("请尽快迁移至 POST /v1/videos");
    } else {
      expect(notes).toContain("scheduled for deprecation and removal");
      expect(notes).toContain("migrate to POST /v1/videos");
    }
  });

  it.each(["zh", "en"])("%s 精确描述持久视频任务查询", (locale) => {
    const endpoints = getSystemDocsVideoEndpoints(locale);
    const endpoint = endpoints.find(
      (item) => item.method === "GET" && item.path === "/v1/videos/{id}"
    );
    if (!endpoint) throw new Error(`${locale} 缺少视频任务查询文档`);

    expect(endpoint.title).toBe("Get video task");
    expect(endpoint.responseExample).toContain('"object": "video.task"');
    expect(endpoint.responseExample).toMatch(/"id": "video_[0-9a-f]{40}"/u);
    expect(endpoint.responseExample).toContain('"input": {');
    expect(endpoint.responseExample).toContain('"created_at":');
    for (const field of OBSOLETE_VIDEO_RESPONSE_FIELDS) {
      expect(endpoint.responseExample).not.toContain(field);
    }
    expect(endpoint.description).not.toMatch(/30 分钟|30 minutes|in-memory/);
    expect(endpoint.notes.join("\n")).not.toMatch(
      /Video task not found or expired|返回结构与 callback_url|identical to the task object/
    );
    expect(endpoint.responses.map((field) => field.name)).toEqual([
      "object",
      "id / task_id / generation_id",
      "status",
      locale === "zh"
        ? "model、duration / duration_seconds、aspectRatio / aspect_ratio、resolution"
        : "model, duration / duration_seconds, aspectRatio / aspect_ratio, resolution",
      "generateAudio / generate_audio",
      "input.mode / input.count",
      "data[].url / video_url",
      "created_at / completed_at",
    ]);
  });
});
