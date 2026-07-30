/**
 * API 账号模型映射与脚本配置契约测试。
 *
 * 覆盖来源唯一性、供应商 ID 保真、未配置透传与脚本体积边界；不执行沙箱代码。
 */
import { describe, expect, it } from "vitest";

import {
  apiModelMappingsSchema,
  apiRequestTransformScriptSchema,
  MAX_API_REQUEST_TRANSFORM_SCRIPT_CHARACTERS,
  resolveApiUpstreamModelId,
} from "./api-upstream-adaptation";

describe("API upstream adaptation contract", () => {
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
});
