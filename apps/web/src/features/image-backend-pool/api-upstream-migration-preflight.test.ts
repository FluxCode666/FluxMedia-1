/**
 * API 上游适配 0077 升级前预检的 DB-free 契约测试。
 *
 * 覆盖新旧 schema 分类、旧 Body 脚本信封包装、UTF-16 大小边界与
 * 生产 QuickJS Worker 编译；数据库中的阻断事务由 0077 真实迁移测试覆盖。
 */
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  ApiUpstreamWorkerProbe,
  ApiUpstreamWorkerProbeError,
  parseApiUpstreamProbeRuntimeConfig,
} from "../../../scripts/api-upstream-worker-probe.mjs";
import {
  ApiUpstreamMigrationPreflightError,
  buildLegacyParameterMappingsTransformScript,
  classifyApiUpstreamAdapterSchema,
  runApiUpstreamAdapterMigrationPreflight,
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
          "parameter_mappings",
        ],
        false
      )
    ).toBe("legacy-parameter-mappings");
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
    expect(
      classifyApiUpstreamAdapterSchema(
        [
          "member_id",
          "api_key",
          "base_url",
          "use_stream",
          "parameter_mappings",
          "model_mappings",
        ],
        false
      )
    ).toBe("partial");
    expect(
      classifyApiUpstreamAdapterSchema(
        [
          "member_id",
          "api_key",
          "current_adapter_version_id",
          "credential_scope",
          "parameter_mappings",
        ],
        true
      )
    ).toBe("partial");
  });

  it("builds the exact pre-0075 parameter mapping script shape", () => {
    expect(buildLegacyParameterMappingsTransformScript("[]")).toBe("");
    const mappings = [
      {
        mode: "move",
        source: "aspect_ratio",
        target: "ratio",
      },
    ];
    const script = buildLegacyParameterMappingsTransformScript(
      JSON.stringify(mappings)
    );
    expect(script).toContain(`const rawRules = ${JSON.stringify(mappings)};`);
    expect(script).toContain("return request;");
    const specialMappingsJson = JSON.stringify([
      {
        mode: "copy",
        source: "input.$&.$`.$'.百分号%",
        target: "vendor.路径",
      },
    ]);
    expect(
      buildLegacyParameterMappingsTransformScript(specialMappingsJson)
    ).toContain(`const rawRules = ${specialMappingsJson};`);
    expect(() =>
      buildLegacyParameterMappingsTransformScript('{"mode":"copy"}')
    ).toThrow(ApiUpstreamMigrationPreflightError);
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

  it("accepts the complete 0073 production shape before running 0075", async () => {
    const configColumns = [
      "member_id",
      "base_url",
      "api_key",
      "use_stream",
      "parameter_mappings",
      "created_at",
      "updated_at",
    ];
    const query = vi.fn(async (statement: string) => {
      if (statement.includes("from information_schema.columns")) {
        return {
          rows: [
            { table_name: "image_backend_member", column_name: "id" },
            { table_name: "image_backend_member", column_name: "type" },
            ...configColumns.map((columnName) => ({
              table_name: "image_backend_member_api_config",
              column_name: columnName,
            })),
            {
              table_name: "video_generation",
              column_name: "backend_member_id",
            },
            { table_name: "video_generation", column_name: "stage" },
          ],
        };
      }
      if (statement.includes("select to_regclass")) {
        return { rows: [{ exists: false }] };
      }
      if (statement.includes("select count(*)::integer as count")) {
        return { rows: [{ count: 0 }] };
      }
      if (statement.includes("config.parameter_mappings::text")) {
        return {
          rows: [
            {
              member_id: "api-member",
              parameter_mappings_json:
                '[{"mode":"move","source":"aspect_ratio","target":"ratio"}]',
            },
          ],
        };
      }
      if (statement.startsWith("begin transaction") || statement === "commit") {
        return { rows: [] };
      }
      throw new Error(`测试收到未处理的 SQL：${statement}`);
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    };
    const preflightPool = pool as unknown as Parameters<
      typeof runApiUpstreamAdapterMigrationPreflight
    >[0];

    await expect(
      runApiUpstreamAdapterMigrationPreflight(preflightPool)
    ).resolves.toEqual({
      schemaState: "legacy-parameter-mappings",
      validatedMemberCount: 1,
      validatedScriptCount: 1,
      nonterminalApiVideoCount: 0,
    });
    expect(release).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.some(([statement]) =>
        statement.includes("config.request_transform_script")
      )
    ).toBe(false);
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

    const migratedParameterMappings =
      buildLegacyParameterMappingsTransformScript(
        '[{"mode":"copy","source":"model","target":"model_id"}]'
      );
    await expect(
      probe.validate(
        wrapLegacyRequestTransformScript(migratedParameterMappings)
      )
    ).resolves.toBeUndefined();
  });
});
