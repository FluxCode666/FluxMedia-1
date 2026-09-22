/**
 * 系统文档外部视频端点契约测试。
 *
 * 使用方：Vitest；防止持久视频任务重新被描述为同步等待、进程内异步任务或旧响应字段。
 * 关键依赖：system-docs 的本地化静态数据，不渲染 React，也不访问网络或数据库。
 */
import { describe, expect, it } from "vitest";

import { getApiIntegrationDocs } from "./api-integration-docs-data";
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
      (item) => item.method === "POST" && item.path === "/v1/videos/generations"
    );
    if (!endpoint) throw new Error(`${locale} 缺少视频创建文档`);

    expect(endpoint.notes.join("\n")).toContain("HTTP 202");
    expect(endpoint.description).toMatch(/OpenAI|风格|FluxMedia/u);
    expect(endpoint.responseExample).toContain('"object": "video.task"');
    expect(endpoint.responseExample).toContain('"kind": "snapshot"');
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

    const callbackField = endpoint.fields.find((field) =>
      field.name.includes("callback_url")
    );
    expect(callbackField?.description).toContain("https");
    const shared = getApiIntegrationDocs(locale).endpoints.find(
      (item) => item.path === endpoint.path
    );
    expect(endpoint.fields).toEqual(shared?.parameters);
    expect(endpoint.responses).toEqual(shared?.responses);
    expect(endpoint.responseExample).toBe(shared?.responseExample);
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
      expect(notes).toContain("POST /v1/videos");
      expect(notes).toContain("已不再提供视频创建");
    } else {
      expect(notes).toContain(
        "POST /v1/videos is no longer a video creation endpoint"
      );
    }
  });

  it.each(["zh", "en"])("%s 精确描述持久视频任务查询", (locale) => {
    const endpoints = getSystemDocsVideoEndpoints(locale);
    const endpoint = endpoints.find(
      (item) => item.method === "GET" && item.path === "/v1/videos/{id}"
    );
    if (!endpoint) throw new Error(`${locale} 缺少视频任务查询文档`);

    expect(endpoint.title).toBe(
      locale === "zh" ? "查询视频任务" : "Get video task"
    );
    expect(endpoint.responseExample).toContain('"object": "video.task"');
    expect(endpoint.responseExample).toContain('"kind": "snapshot"');
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
    const shared = getApiIntegrationDocs(locale).endpoints.find(
      (item) => item.path === endpoint.path
    );
    expect(endpoint.fields).toEqual(shared?.parameters);
    expect(endpoint.responses).toEqual(shared?.responses);
    expect(endpoint.description).toBe(shared?.description);
  });
});
