/**
 * API 账号模型映射与脚本配置契约测试。
 *
 * 覆盖来源唯一性、供应商 ID 保真、未配置透传与脚本体积边界；不执行沙箱代码。
 */
import { describe, expect, it } from "vitest";

import {
  API_UPSTREAM_AUTH_MODES,
  apiModelMappingsSchema,
  apiRequestTransformScriptSchema,
  apiUpstreamAdapterDraftSchema,
  apiUpstreamAuthenticationSchema,
  DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT,
  MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS,
  resolveApiUpstreamModelId,
  resolveApiUpstreamOperationPath,
} from "./api-upstream-adaptation";

describe("API upstream adaptation contract", () => {
  it("视频创建额外重试次数默认 2 且只接受 0 到 10 的整数", () => {
    const baseDraft = {
      baseUrl: "http://api.internal:8080/v1",
      useStream: false,
      modelMappings: [],
      authentication: { mode: "none" as const },
      credentialScope: "http://api.internal:8080|none",
      operations: {
        "images.generate": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
        "images.generate.query": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
        "images.edit": { path: "", requestScript: "", responseScript: "" },
        "images.edit.query": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
        "videos.generate": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
        "videos.query": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
      },
    };

    expect(DEFAULT_VIDEO_SUBMISSION_RETRY_COUNT).toBe(2);
    expect(apiUpstreamAdapterDraftSchema.parse(baseDraft)).toMatchObject({
      videoSubmissionRetryCount: 2,
    });
    for (const videoSubmissionRetryCount of [0, 2, 10]) {
      expect(
        apiUpstreamAdapterDraftSchema.safeParse({
          ...baseDraft,
          videoSubmissionRetryCount,
        }).success
      ).toBe(true);
    }
    for (const videoSubmissionRetryCount of [-1, 1.5, 11]) {
      expect(
        apiUpstreamAdapterDraftSchema.safeParse({
          ...baseDraft,
          videoSubmissionRetryCount,
        }).success
      ).toBe(false);
    }
  });

  it("按平台模型大小写不敏感匹配并保留上游 ID 格式", () => {
    expect(
      resolveApiUpstreamModelId("Seedance2", [
        { modelId: "seedance2", upstreamModelId: "Seedande-2.0/Preview" },
      ])
    ).toBe("Seedande-2.0/Preview");
  });

  it("没有配置模型映射时透传平台真实模型 ID", () => {
    expect(resolveApiUpstreamModelId("seedance2-fast", [])).toBe(
      "seedance2-fast"
    );
  });

  it("拒绝大小写不同但来源相同的重复模型映射", () => {
    expect(
      apiModelMappingsSchema.safeParse([
        { modelId: "seedance2", upstreamModelId: "vendor-a" },
        { modelId: "SEEDANCE2", upstreamModelId: "vendor-b" },
      ]).success
    ).toBe(false);
  });

  it("允许多个平台模型映射到同一个供应商模型", () => {
    expect(
      apiModelMappingsSchema.safeParse([
        { modelId: "seedance2", upstreamModelId: "vendor-shared" },
        { modelId: "seedance2-fast", upstreamModelId: "vendor-shared" },
      ]).success
    ).toBe(true);
  });

  it("空白脚本归一为空字符串并拒绝超长源码", () => {
    expect(apiRequestTransformScriptSchema.parse("  \n")).toBe("");
    expect(
      apiRequestTransformScriptSchema.safeParse(
        "x".repeat(MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS + 1)
      ).success
    ).toBe(false);
  });

  it("仅接受四种系统认证模式并校验自定义认证 Header", () => {
    expect(API_UPSTREAM_AUTH_MODES).toEqual([
      "bearer",
      "raw_authorization",
      "custom_header",
      "none",
    ]);
    expect(
      apiUpstreamAuthenticationSchema.safeParse({ mode: "bearer" }).success
    ).toBe(true);
    expect(
      apiUpstreamAuthenticationSchema.safeParse({
        mode: "custom_header",
        headerName: "X-Api-Key",
      }).success
    ).toBe(true);
    expect(
      apiUpstreamAuthenticationSchema.safeParse({
        mode: "custom_header",
        headerName: "Host",
      }).success
    ).toBe(false);
    expect(
      apiUpstreamAuthenticationSchema.safeParse({ mode: "basic" }).success
    ).toBe(false);
  });

  it("解析内置路径并保留图片查询未配置语义", () => {
    expect(resolveApiUpstreamOperationPath("images.generate", "")).toBe(
      "/images/generations"
    );
    expect(resolveApiUpstreamOperationPath("images.edit", "")).toBe(
      "/images/edits"
    );
    expect(resolveApiUpstreamOperationPath("videos.generate", "")).toBe(
      "/videos/generations"
    );
    expect(resolveApiUpstreamOperationPath("videos.query", "")).toBe(
      "/videos/{task_id}"
    );
    expect(
      resolveApiUpstreamOperationPath("images.generate.query", "")
    ).toBeNull();
    expect(resolveApiUpstreamOperationPath("images.edit.query", "")).toBeNull();
  });

  it("查询路径必须包含 task_id 且所有路径不能逃逸 baseUrl", () => {
    const valid = {
      baseUrl: "http://api.internal:8080/v1",
      useStream: false,
      modelMappings: [],
      authentication: { mode: "none" },
      credentialScope: "http://api.internal:8080|none",
      operations: {
        "images.generate": {
          path: "/custom/images",
          requestScript: "",
          responseScript: "",
        },
        "images.generate.query": {
          path: "/custom/images/{task_id}",
          requestScript: "",
          responseScript: "",
        },
        "images.edit": { path: "", requestScript: "", responseScript: "" },
        "images.edit.query": {
          path: "",
          requestScript: "",
          responseScript: "",
        },
        "videos.generate": { path: "", requestScript: "", responseScript: "" },
        "videos.query": { path: "", requestScript: "", responseScript: "" },
      },
    };
    expect(apiUpstreamAdapterDraftSchema.safeParse(valid).success).toBe(true);
    expect(
      apiUpstreamAdapterDraftSchema.safeParse({
        ...valid,
        operations: {
          ...valid.operations,
          "images.generate.query": {
            path: "/custom/images/status",
            requestScript: "",
            responseScript: "",
          },
        },
      }).success
    ).toBe(false);
    for (const path of [
      "https://evil.example/tasks/{task_id}",
      "//evil.example/tasks/{task_id}",
      "/../tasks/{task_id}",
      "/%2e%2e/tasks/{task_id}",
      "\\\\evil.example\\tasks\\{task_id}",
    ]) {
      expect(() =>
        resolveApiUpstreamOperationPath("videos.query", path)
      ).toThrow();
    }
  });
});
