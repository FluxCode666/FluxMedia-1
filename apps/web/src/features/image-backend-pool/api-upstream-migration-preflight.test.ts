/**
 * API 上游适配 0077 升级前预检的 DB-free 契约测试。
 *
 * 覆盖新旧 schema 分类、旧 Body 脚本信封包装、UTF-16 大小边界与
 * 生产 QuickJS Worker 编译；数据库中的阻断事务由 0077 真实迁移测试覆盖。
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  ApiUpstreamWorkerProbe,
  ApiUpstreamWorkerProbeError,
  parseApiUpstreamProbeRuntimeConfig,
} from "../../../scripts/api-upstream-worker-probe.mjs";
import {
  ApiUpstreamMigrationPreflightError,
  classifyApiUpstreamAdapterSchema,
  wrapLegacyRequestTransformScript,
} from "../../../scripts/preflight-api-upstream-adapter-migration.mjs";

const probe = new ApiUpstreamWorkerProbe();

afterAll(async () => {
  await probe.close();
});

describe("API upstream adapter migration preflight", () => {
  it("distinguishes the complete legacy, versioned and partial schemas", () => {
    expect(
      classifyApiUpstreamAdapterSchema(
        [
          "member_id",
          "api_key",
          "base_url",
          "use_stream",
          "model_mappings",
          "request_transform_script",
        ],
        false
      )
    ).toBe("legacy");
    expect(
      classifyApiUpstreamAdapterSchema(
        [
          "member_id",
          "api_key",
          "current_adapter_version_id",
          "credential_scope",
        ],
        true
      )
    ).toBe("versioned");
    expect(
      classifyApiUpstreamAdapterSchema(
        ["member_id", "api_key", "base_url", "credential_scope"],
        true
      )
    ).toBe("partial");
  });

  it("keeps empty scripts empty and wraps a legacy body result in an envelope", () => {
    expect(wrapLegacyRequestTransformScript("  \n")).toBe("");
    const wrapped = wrapLegacyRequestTransformScript(
      "request.vendor_model = request.model; return request;"
    );
    expect(wrapped).toContain("const legacyBody = ((request) => {");
    expect(wrapped).toContain("})(request.body);");
    expect(wrapped).toContain("return { body: legacyBody };");
    expect(wrapped).not.toContain("apiKey");
  });

  it("uses deployment defaults and rejects an invalid worker count", () => {
    expect(parseApiUpstreamProbeRuntimeConfig({})).toEqual({
      workerCount: 1,
      memoryLimitBytes: 32 * 1024 * 1024,
      stackLimitBytes: 512 * 1024,
    });
    expect(() =>
      parseApiUpstreamProbeRuntimeConfig({
        API_UPSTREAM_SCRIPT_WORKER_COUNT: "9",
      })
    ).toThrow(ApiUpstreamWorkerProbeError);
  });

  it("rejects a source whose wrapped form would exceed the new script limit", () => {
    const source = `//${"x".repeat(32_700)}\nreturn request;`;
    expect(() => wrapLegacyRequestTransformScript(source)).toThrow(
      ApiUpstreamMigrationPreflightError
    );
  });

  it("compiles the exact migrated shape in the production QuickJS worker", async () => {
    const wrapped = wrapLegacyRequestTransformScript(
      "const rename = (value) => value; request.vendor_model = rename(request.model); delete request.model; return request;"
    );
    await expect(probe.validate(wrapped)).resolves.toBeUndefined();
    await expect(
      probe.validate(
        wrapLegacyRequestTransformScript("if (request.model { return request;")
      )
    ).rejects.toMatchObject({ code: "worker_job_failed" });
  });
});
