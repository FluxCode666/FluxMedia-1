/**
 * 公开 API 接入文档的数据契约测试。
 *
 * 防止管理员系统文档后续扩充时，把未支持的站点扩展参数或响应字段误带到无需登录
 * 即可访问的图片与视频接入页，并锁定视频能力发现和持久任务协议。
 */
import { describe, expect, it } from "vitest";

import {
  getApiIntegrationDocs,
  getApiIntegrationHomepageContract,
} from "./api-integration-docs-data";

const EXPECTED_PATHS = [
  "/v1/models",
  "/v1/credits",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/videos",
  "/v1/videos/capabilities",
  "/v1/images/{task_id}",
  "/v1/videos/{id}",
] as const;

const FORBIDDEN_EXTENSION_NAMES = [
  "force_firefly",
  "forceFirefly",
  "transparent_matte",
  "hd_repair",
  "hdRepair",
  "block_repair",
  "blockRepair",
  "repair_prompt",
  "repairPrompt",
  "async",
  "promptOptimization",
  "prompt_optimization",
  "promptRepair",
  "prompt_repair",
  "gptModel",
  "gpt_model",
  "thinking",
  "web_first",
  "webFirst",
  "force_web",
  "forceWeb",
  "image_url",
  "image_urls",
  "mask_url",
  "mask_image_url",
  "generationId",
  "credits_consumed",
] as const;

describe("API integration docs data", () => {
  it.each(["zh", "en"])("%s 为首页提取同源端点、鉴权和复制契约", (locale) => {
    const content = getApiIntegrationDocs(locale);
    const generation = content.endpoints.find(
      (endpoint) => endpoint.id === "image-generations"
    );
    const homepage = getApiIntegrationHomepageContract(locale);

    expect(homepage).toEqual({
      endpoint: {
        contentType: generation?.contentType,
        method: generation?.method,
        path: generation?.path,
      },
      authentication: {
        environmentVariable: "FLUXMEDIA_API_KEY",
        headerName: "Authorization",
        scheme: "Bearer",
      },
      copyLabels: content.copyLabels,
    });
    expect(homepage.endpoint).not.toHaveProperty("requestExample");
    expect(homepage.endpoint).not.toHaveProperty("responseExample");
  });

  it.each(["zh", "en"])("%s 公开八个现行接入端点", (locale) => {
    const content = getApiIntegrationDocs(locale);

    expect(content.endpoints.map((endpoint) => endpoint.path)).toEqual(
      EXPECTED_PATHS
    );
    expect(
      content.endpoints.filter((endpoint) => endpoint.operation === "video")
    ).toHaveLength(3);
  });

  it.each(["zh", "en"])("%s 按三个模块完整编排接口目录", (locale) => {
    const content = getApiIntegrationDocs(locale);
    const groupedEndpointIds = content.groups.flatMap(
      (group) => group.endpointIds
    );

    expect(content.groups.map((group) => group.id)).toEqual([
      "api-basics",
      "image-api",
      "video-api",
    ]);
    expect([...groupedEndpointIds].sort()).toEqual(
      content.endpoints.map((endpoint) => endpoint.id).sort()
    );
    expect(new Set(groupedEndpointIds).size).toBe(groupedEndpointIds.length);
    expect(content.directoryTitle).toBeTruthy();
    expect(content.directoryDescription).toBeTruthy();
  });

  it.each([
    "zh",
    "en",
  ])("%s 按当前请求域名生成示例并公开模型与积分接入闭环", (locale) => {
    const baseUrl = "https://tenant.example.test";
    const content = getApiIntegrationDocs(locale, baseUrl);
    const models = content.endpoints.find(
      (endpoint) => endpoint.id === "models"
    );
    const credits = content.endpoints.find(
      (endpoint) => endpoint.id === "credits"
    );

    expect(content.baseUrl).toBe(baseUrl);
    for (const endpoint of content.endpoints) {
      expect(endpoint.requestExample).toContain(`curl ${baseUrl}`);
      expect(endpoint.responseExample).not.toContain("{{FLUXMEDIA_BASE_URL}}");
      expect(endpoint.responseExample).not.toContain("gpt2image.superapi.buzz");
    }
    expect(models?.path).toBe("/v1/models");
    expect(models?.responseExample).toContain('"object": "list"');
    expect(models?.responses.map((response) => response.name)).toContain(
      "data[].id"
    );
    expect(credits?.path).toBe("/v1/credits");
    expect(credits?.responseExample).toContain('"object": "credit_balance"');
    expect(credits?.responseExample).toContain('"credits_remaining"');
    expect(credits?.responseExample).toContain('"last_used_at"');
  });

  it("为并发域名请求返回互不污染的独立文档副本", () => {
    const firstBaseUrl = "https://first.example.test";
    const secondBaseUrl = "https://second.example.test";
    const first = getApiIntegrationDocs("zh", firstBaseUrl);
    const second = getApiIntegrationDocs("zh", secondBaseUrl);
    const firstText = JSON.stringify(first);
    const secondText = JSON.stringify(second);

    expect(firstText).toContain(firstBaseUrl);
    expect(firstText).not.toContain(secondBaseUrl);
    expect(secondText).toContain(secondBaseUrl);
    expect(secondText).not.toContain(firstBaseUrl);
    expect(firstText).not.toContain("{{FLUXMEDIA_BASE_URL}}");
    expect(secondText).not.toContain("{{FLUXMEDIA_BASE_URL}}");
  });

  it.each([
    "zh",
    "en",
  ])("%s 公开视频契约使用真实模型、能力发现和持久任务协议", (locale) => {
    const content = getApiIntegrationDocs(locale);
    const create = content.endpoints.find(
      (endpoint) => endpoint.id === "video-generations"
    );
    const capabilities = content.endpoints.find(
      (endpoint) => endpoint.id === "video-capabilities"
    );
    const task = content.endpoints.find(
      (endpoint) => endpoint.id === "video-task"
    );
    const createText = JSON.stringify(create);
    const capabilitiesText = JSON.stringify(capabilities);
    const capabilitiesResponse = capabilities?.responseExample ?? "";
    const taskText = JSON.stringify(task);

    expect(create?.requestExample).toContain('"model": "seedance2"');
    expect(create?.responseExample).toMatch(/"id": "video_[0-9a-f]{40}"/u);
    expect(create?.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining([
        "seconds / duration / duration_seconds",
        "aspectRatio / aspect_ratio",
        "resolution",
        locale === "zh"
          ? "firstFrame / first_frame、lastFrame / last_frame"
          : "firstFrame / first_frame, lastFrame / last_frame",
        "referenceImages / reference_images",
      ])
    );
    expect(createText).toContain("HTTP 202");
    expect(createText).toContain("/v1/videos/generations");
    expect(createText).toContain("/api/v1/videos/generations");
    expect(createText).toContain("/api/v1/videos");
    if (locale === "zh") {
      expect(createText).toContain("即将废弃下线");
      expect(createText).toContain("请尽快迁移至 POST /v1/videos");
    } else {
      expect(createText).toContain("scheduled for deprecation and removal");
      expect(createText).toContain("Migrate to POST /v1/videos");
    }
    expect(create?.responseExample).toContain('"status": "queued"');
    expect(createText).not.toContain("kling3-omni-8s-16x9-1080p");
    expect(createText).not.toContain("firefly-<family>");
    expect(createText).not.toContain("input_image_role");
    expect(createText).toContain("https webhook");
    expect(capabilities?.path).toBe("/v1/videos/capabilities");
    expect(capabilities?.responseExample).toContain('"model": "seedance2"');
    expect(capabilities?.responseExample).toContain(
      '"frames": "first-and-optional-last"'
    );
    expect(capabilities?.responseExample).toContain('"maxCount": 10');
    expect(capabilitiesText).toContain("configuredReachable");
    expect(capabilitiesText).toContain("maxMediaInputBytes");
    expect(capabilitiesResponse).not.toMatch(
      /apiKey|api_key|cookie|credential|inflight/iu
    );
    expect(task?.responseExample).toContain('"object": "video.task"');
    expect(task?.responseExample).toMatch(/"id": "video_[0-9a-f]{40}"/u);
    expect(taskText).toContain("in_progress");
    expect(taskText).not.toContain("needs_attention");
    expect(taskText).toMatch(/persistent|持久/u);
    expect(taskText).not.toContain("30 minutes");
    expect(taskText).not.toContain("30 分钟");
  });

  it.each(["zh", "en"])("%s 不展示站点扩展字段或示例", (locale) => {
    const content = getApiIntegrationDocs(locale);
    const visibleNames = content.endpoints.flatMap((endpoint) => [
      ...endpoint.parameters.map((parameter) => parameter.name),
      ...endpoint.responses.map((response) => response.name),
    ]);
    const examples = content.endpoints
      .flatMap((endpoint) => [
        endpoint.requestExample,
        endpoint.responseExample,
      ])
      .join("\n");

    for (const forbiddenName of FORBIDDEN_EXTENSION_NAMES) {
      expect(visibleNames.join("\n")).not.toContain(forbiddenName);
      expect(examples).not.toContain(`"${forbiddenName}"`);
    }
  });

  it("保留图片任务查询端点不可缺少的路径参数", () => {
    const endpoints = getApiIntegrationDocs("zh").endpoints;
    const imageTask = endpoints.find(
      (endpoint) => endpoint.path === "/v1/images/{task_id}"
    );

    expect(imageTask?.parameters.map((parameter) => parameter.name)).toContain(
      "task_id"
    );
  });

  it("为每个公开可选参数声明默认行为", () => {
    for (const locale of ["zh", "en"] as const) {
      const content = getApiIntegrationDocs(locale);
      for (const endpoint of content.endpoints) {
        for (const parameter of endpoint.parameters) {
          const isOptional =
            parameter.requirement === "可选" ||
            parameter.requirement === "Optional";
          if (isOptional) {
            expect(
              parameter.defaultValue?.trim(),
              `${locale}:${endpoint.id}:${parameter.name}`
            ).toBeTruthy();
          }
        }
      }
    }
  });

  it("与外部图片处理链的真实默认契约保持一致", () => {
    const endpoints = getApiIntegrationDocs("zh").endpoints;
    const generation = endpoints.find(
      (endpoint) => endpoint.id === "image-generations"
    );
    const edit = endpoints.find((endpoint) => endpoint.id === "image-edits");
    const generationDefaults = Object.fromEntries(
      (generation?.parameters ?? [])
        .filter((parameter) => parameter.requirement === "可选")
        .map((parameter) => [parameter.name, parameter.defaultValue])
    );
    const editDefaults = Object.fromEntries(
      (edit?.parameters ?? [])
        .filter((parameter) => parameter.requirement === "可选")
        .map((parameter) => [parameter.name, parameter.defaultValue])
    );
    const commonDefaults = {
      size: "1024x1024",
      quality: "auto",
      moderation: "auto",
      response_format: "b64_json",
      output_format: "未指定（上游决定）",
      output_compression: "未指定（上游决定）",
      background: "未指定（上游决定）",
      stream: "false",
    };

    expect(generationDefaults).toEqual(commonDefaults);
    expect(editDefaults).toEqual({ mask: "无", ...commonDefaults });
    expect(generation?.requestExample).not.toContain('"n"');
    expect(
      generation?.parameters.map((parameter) => parameter.name)
    ).not.toContain("n");
    expect(edit?.parameters.map((parameter) => parameter.name)).not.toContain(
      "n"
    );
  });

  it("说明 output_compression 的用途与生效范围", () => {
    const expectations = {
      zh: [
        "控制输出图片的压缩级别",
        "数值越大，压缩力度越大",
        "0 表示不压缩，100 表示最大压缩",
        "output_format 为 jpeg 或 webp",
        "不同上游",
      ],
      en: [
        "Controls the output image compression level",
        "Higher values apply stronger compression",
        "0 means no compression and 100 means maximum compression",
        "output_format is jpeg or webp",
        "upstream provider",
      ],
    } as const;

    for (const locale of ["zh", "en"] as const) {
      const content = getApiIntegrationDocs(locale);
      const compressionParameters = content.endpoints.flatMap((endpoint) =>
        endpoint.parameters.filter(
          (parameter) => parameter.name === "output_compression"
        )
      );

      expect(compressionParameters).toHaveLength(2);
      for (const parameter of compressionParameters) {
        for (const phrase of expectations[locale]) {
          expect(parameter.description).toContain(phrase);
        }
      }
    }
  });
});
